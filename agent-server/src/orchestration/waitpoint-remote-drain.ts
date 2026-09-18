// input:  armed waitpoints whose emitFrom names a device, client-manager's command channel
// output: drainDeviceSpools
// pos:    Collects signals from connected devices. A job on a lab box cannot POST to the daemon —
//         the webhook listens on loopback only — so the daemon goes and fetches instead, over the
//         WebSocket the device already holds open.
//
//         Nothing is installed on the device and no protocol is added: this is three ordinary
//         `bash` actions (list, read, remove) of the kind remote_bash already sends. The
//         alternative, a client-side push, would mean a new message type and a change to the
//         hot-reload bundle — a protocol change on both ends, for a 30s latency win.
//
//         Read-then-apply-then-remove, in that order. A crash between apply and remove replays the
//         file on the next tick, where the filename-as-dedupe-key drops it. The reverse order would
//         lose signals instead, which is the failure that matters.

import { createLogger } from '@core/log.js';
import { waitpointRepo } from '@store/waitpoint-repo.js';
import { isDeviceOnline, sendCommand } from '@domain/remote/client-manager.js';
import { ingestSignal, productionIngestDeps, toSignalInput, type IngestDeps } from './waitpoint-ingress.js';

const log = createLogger('waitpoint-drain');

/** Marker the read command prints before each file, so one round trip returns the whole batch. */
const FILE_MARKER = '===CORTEX-SIGNAL:';

/**
 * Spool location on the device. A literal — nothing from a waitpoint is ever interpolated into a
 * command string, which is what keeps this from being an injection surface.
 */
const REMOTE_SPOOL = '"$HOME/.cortex/tmp/signals"';

/** Per-file read ceiling, matching the local spool cap. */
const READ_CAP_BYTES = 64 * 1024;

const READ_COMMAND = [
  `d=${REMOTE_SPOOL}`,
  '[ -d "$d" ] || exit 0',
  'for f in "$d"/*.json; do',
  '  [ -f "$f" ] || continue',
  `  printf '%s%s\\n' '${FILE_MARKER}' "$(basename "$f")"`,
  `  head -c ${READ_CAP_BYTES} "$f"`,
  "  printf '\\n'",
  'done',
].join('\n');

/** Only names this shape are ever echoed back into a command. */
const SAFE_NAME = /^[A-Za-z0-9._-]+\.json$/;

export interface RemoteDrainDeps {
  ingest: IngestDeps;
  listDeviceTargets: () => Promise<string[]>;
  isDeviceOnline: (device: string) => boolean;
  runBash: (device: string, command: string, timeoutMs: number) => Promise<{ stdout: string }>;
}

async function listDevicesWithArmedWaitpoints(): Promise<string[]> {
  const armed = await waitpointRepo.listArmed();
  const devices = new Set<string>();
  for (const wp of armed) {
    if (wp.emitFrom.kind === 'device' && wp.emitFrom.device) devices.add(wp.emitFrom.device);
  }
  return [...devices];
}

export const productionRemoteDrainDeps: RemoteDrainDeps = {
  ingest: productionIngestDeps,
  listDeviceTargets: listDevicesWithArmedWaitpoints,
  isDeviceOnline,
  runBash: async (device, command, timeoutMs) => {
    const result = await sendCommand(device, {
      action: 'bash',
      params: { command, timeout: timeoutMs },
      timeout: timeoutMs,
    });
    return { stdout: String(result?.stdout ?? '') };
  },
};

/** Split the read command's output back into `{ name, body }` pairs. */
export function parseSpoolBatch(stdout: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const chunks = stdout.split(FILE_MARKER);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const newline = chunk.indexOf('\n');
    if (newline < 0) continue;
    const name = chunk.slice(0, newline).trim();
    const body = chunk.slice(newline + 1);
    if (!SAFE_NAME.test(name)) {
      log.warn(`skipping spool entry with an unusable name: ${JSON.stringify(name).slice(0, 80)}`);
      continue;
    }
    out.push({ name, body });
  }
  return out;
}

/**
 * Drain one device's spool. Returns how many signals were applied.
 *
 * `device` is a registry key, not user text, but it is still never put into a command string —
 * it only selects which socket the command goes down.
 */
async function drainOneDevice(device: string, deps: RemoteDrainDeps): Promise<number> {
  const { stdout } = await deps.runBash(device, READ_COMMAND, 30_000);
  const entries = parseSpoolBatch(stdout);
  if (entries.length === 0) return 0;

  const done: string[] = [];
  let applied = 0;
  for (const entry of entries) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(entry.body);
      if (typeof payload !== 'object' || payload === null) throw new Error('not an object');
    } catch {
      // Leave it on the device rather than deleting evidence of a malformed writer; the name is
      // logged so it can be found. It will be re-read, and re-skipped, each tick.
      log.warn(`${device}: spool entry ${entry.name} is not JSON; leaving it in place`);
      continue;
    }
    const outcome = await ingestSignal(
      toSignalInput(payload, `spool:${device}:${entry.name}`, `device:${device}`),
      deps.ingest,
    );
    if (outcome.kind === 'rate-limited') continue;
    if (outcome.kind === 'bad-secret') {
      log.warn(`${device}: spool entry ${entry.name} has a bad secret; leaving it in place`);
      continue;
    }
    done.push(entry.name);
    if (outcome.kind === 'accepted') applied += 1;
  }

  if (done.length > 0) {
    // Names are validated against SAFE_NAME above, so single-quoting is sufficient and there is
    // nothing left that could close the quote.
    const args = done.map((n) => `'${n}'`).join(' ');
    await deps.runBash(device, `cd ${REMOTE_SPOOL} && rm -f -- ${args}`, 15_000)
      .catch((e) => log.error(`${device}: failed to clear ${done.length} drained signal(s): ${(e as Error).message}`));
  }
  return applied;
}

/**
 * Visit every device that owns at least one armed waitpoint and collect what it left for us.
 * Offline devices are skipped silently — their files keep until they reconnect.
 */
export async function drainDeviceSpools(deps: RemoteDrainDeps = productionRemoteDrainDeps): Promise<number> {
  const devices = await deps.listDeviceTargets();
  let applied = 0;
  for (const device of devices) {
    if (!deps.isDeviceOnline(device)) continue;
    try {
      applied += await drainOneDevice(device, deps);
    } catch (error) {
      log.error(`${device}: spool drain failed: ${(error as Error).message}`);
    }
  }
  return applied;
}
