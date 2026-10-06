import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { runSsh, SSH_BASE_OPTIONS } from './ssh-exec.js';

const log = createLogger('client-ssh-tunnel');

export interface SshTunnelSpec {
  device: string;
  host: string;
  remotePort: number;
  serverPort: number;
  /**
   * Optional remote command run for the lifetime of the tunnel, in place of `-N`. Its only job is
   * to leave a findable process on the far side: `ssh -N` puts nothing there but sshd itself, and
   * sshd marks itself non-dumpable, so an unprivileged `fuser`/`lsof`/`ss -p` cannot say which
   * process owns a forward listener. A marker command gives the session an ordinary greppable
   * child whose parent is exactly the sshd holding `remotePort`.
   */
  markerCommand?: string;
  /**
   * Optional remote shell command run immediately before each `ssh -R` spawn, to release
   * `remotePort` on the far side. Both platforms strand the listener when our end dies without a
   * clean close, for different reasons:
   * - Windows OpenSSH leaves it in an orphaned `sshd -z` child and then lets a second sshd bind
   *   the same loopback port instead of failing, so the cortex-client reconnects into the dead
   *   listener and the device stays offline even though a healthy tunnel exists.
   * - POSIX sshd keeps it while it blocks writing the session's exit status into the black hole,
   *   so it outlives the session by a full TCP retransmission timeout (~15 min) and every spawn
   *   in between dies on `ExitOnForwardFailure`.
   */
  freeRemotePortCommand?: string;
}

type TunnelState = 'stopped' | 'starting' | 'running' | 'backoff' | 'stopping';
type ExecSsh = (args: string[], timeoutMs?: number) => Promise<string>;
type SpawnSsh = (args: string[]) => ChildProcess;

interface TunnelDeps {
  execSsh?: ExecSsh;
  spawnSsh?: SpawnSsh;
  controlDir?: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  stopTimeoutMs?: number;
}

interface TunnelRecord {
  spec: SshTunnelSpec;
  state: TunnelState;
  generation: number;
  child: ChildProcess | null;
  ensurePromise: Promise<void> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  lastError: Error | null;
}

const DEFAULT_CONTROL_DIR = path.join(STORE_DIR, 'client-ssh-tunnels');

function defaultExecSsh(args: string[], timeoutMs = 5000): Promise<string> {
  return runSsh(args, timeoutMs);
}

function defaultSpawnSsh(args: string[]): ChildProcess {
  return spawn('ssh', args, { stdio: 'ignore' });
}

/**
 * Kill the sshd sessions still listening on the tunnel's loopback port on a Windows host. Windows
 * OpenSSH neither tears the forward listener down with the session nor refuses a duplicate bind,
 * so a dead tunnel can keep answering the cortex-client while a healthy one sits next to it
 * unused — and several can pile up on one port.
 *
 * It loops because `Get-NetTCPConnection` reports a single row per endpoint no matter how many
 * sockets are bound to it: with two listeners on the port, `netstat -ano` and .NET's
 * `GetActiveTcpListeners()` both show two and the cmdlet shows one — the oldest. One pass would
 * evict one listener and leave the rest, so it repeats until no sshd holds the port.
 *
 * The owner is checked by name because the kill is otherwise indiscriminate: whatever happens to
 * be listening on the port gets force-stopped, which is a stray kill waiting to happen if anything
 * else ever binds it. This is the same guard the POSIX command applies through `comm`.
 */
function windowsFreePortCommand(port: number): string {
  return 'powershell -NoProfile -Command "for ($i = 0; $i -lt 8; $i++) { '
    + `$t = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | `
    + "Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'sshd' }); "
    + 'if (-not $t) { break }; '
    + '$t | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; '
    + 'Start-Sleep -Milliseconds 250 }"';
}

/** Tags a POSIX tunnel's remote session so a stale one can be found by name rather than by port. */
function posixTunnelMarker(port: number): string {
  return `cortex-tunnel-${port}`;
}

/**
 * The remote end of a POSIX tunnel: a shell that parks with the marker in its own argv for as long
 * as the sshd that spawned it lives. `ssh -N` would leave nothing on the far side but sshd, and
 * sshd marks itself non-dumpable, so `/proc/<sshd>/fd` is root-only and an unprivileged
 * `fuser`/`lsof`/`ss -p` reports no owner for the forward listener at all — a stale one simply
 * cannot be located from the port. This process is an ordinary child of that sshd, which turns
 * "who holds the port" into a `pgrep`.
 *
 * It has to watch its parent rather than park forever: `-T` gives the session no pty, so nothing
 * sends SIGHUP when sshd goes away, and a plain `sleep` loop would be reparented to init and leak
 * one process per tunnel restart. Watching the parent by pid also keeps the black-hole case right
 * — there sshd is still alive, so the marker stays put and stays findable.
 */
function posixTunnelCommand(port: number): string {
  return "exec sh -c 'P=$PPID; while kill -0 $P 2>/dev/null; do sleep 30; done"
    + ` # ${posixTunnelMarker(port)}'`;
}

/**
 * Evict a stale POSIX tunnel by killing the sshd session that owns its listener. When the link
 * dies without a clean close, sshd blocks writing the session's exit status into the black hole
 * and keeps the forward bound for a full TCP retransmission timeout (~15 min); every `ssh -R` in
 * that window dies on ExitOnForwardFailure. Killing the marker's parent needs no privilege — that
 * sshd runs as us — but it does need care: `/proc/<pid>/stat` is read past the last `)` because a
 * process name may contain spaces, and the kill is gated on the parent actually being an sshd, so
 * neither a recycled PID nor a marker already reparented to init can turn this into a stray kill.
 * The name is matched as a prefix because OpenSSH 9.8+ renamed the per-connection process to
 * `sshd-session`. The `[-]` keeps the pattern from matching the command's own shell, which would
 * otherwise make this hang up on itself.
 */
function posixFreePortCommand(port: number): string {
  const pattern = posixTunnelMarker(port).replace('cortex-', 'cortex[-]');
  return `for p in $(pgrep -f "${pattern}"); do `
    + 'pp=$(sed -e "s/^.*) //" /proc/$p/stat 2>/dev/null | cut -d" " -f2); '
    + '[ -n "$pp" ] || continue; '
    + 'case "$(cat /proc/$pp/comm 2>/dev/null)" in sshd*) kill "$pp";; esac; '
    + 'done; exit 0';
}

/** The reverse tunnel that carries a device's client back to the hub, with its platform's eviction. */
export function reverseTunnelSpec(
  route: Pick<SshTunnelSpec, 'device' | 'host' | 'remotePort' | 'serverPort'>,
  win: boolean,
): SshTunnelSpec {
  if (win) return { ...route, freeRemotePortCommand: windowsFreePortCommand(route.remotePort) };
  return {
    ...route,
    markerCommand: posixTunnelCommand(route.remotePort),
    freeRemotePortCommand: posixFreePortCommand(route.remotePort),
  };
}

export function buildSshTunnelArgs(spec: SshTunnelSpec, controlPath: string): string[] {
  const args = [
    '-M', '-S', controlPath, '-T',
    // A marker command replaces `-N`: the session has to run something for the far side to be
    // identifiable later. Both forms keep the forward alive for the life of the ssh process.
    ...(spec.markerCommand ? [] : ['-N']),
    ...SSH_BASE_OPTIONS,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-R', `127.0.0.1:${spec.remotePort}:127.0.0.1:${spec.serverPort}`,
    spec.host,
  ];
  if (spec.markerCommand) args.push(spec.markerCommand);
  return args;
}

// Compares where the tunnel points, which is what cannot change under a live supervisor.
// `markerCommand` and `freeRemotePortCommand` are deliberately excluded: both are derived from the
// ports compared here plus the host's OS, so treating either as a route change would only fire on
// a `win` flag edit — and wedging a device permanently over that is a worse failure than using a
// stale command.
function sameSpec(a: SshTunnelSpec, b: SshTunnelSpec): boolean {
  return a.host === b.host && a.remotePort === b.remotePort && a.serverPort === b.serverPort;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A failure retrying cannot fix. The retry chain stops on it instead of logging forever. */
class PermanentTunnelError extends Error {}

function hasLiveChild(record: TunnelRecord): boolean {
  const child = record.child;
  return !!child && child.exitCode === null && child.signalCode === null;
}

export class SshTunnelSupervisor {
  private readonly records = new Map<string, TunnelRecord>();
  private readonly execSsh: ExecSsh;
  private readonly spawnSsh: SpawnSsh;
  private readonly controlDir: string;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly readyTimeoutMs: number;
  private readonly readyPollMs: number;
  private readonly stopTimeoutMs: number;
  private stopping = false;

  constructor(deps: TunnelDeps = {}) {
    this.execSsh = deps.execSsh ?? defaultExecSsh;
    this.spawnSsh = deps.spawnSsh ?? defaultSpawnSsh;
    this.controlDir = deps.controlDir ?? DEFAULT_CONTROL_DIR;
    this.retryBaseMs = deps.retryBaseMs ?? 1000;
    this.retryMaxMs = deps.retryMaxMs ?? 30_000;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 10_000;
    this.readyPollMs = deps.readyPollMs ?? 100;
    this.stopTimeoutMs = deps.stopTimeoutMs ?? 2000;
  }

  state(device: string): TunnelState {
    return this.records.get(device)?.state ?? 'stopped';
  }

  resume(): void {
    this.stopping = false;
  }

  ensure(spec: SshTunnelSpec): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('SSH tunnel supervisor is stopping'));
    const record = this.getOrCreate(spec);
    if (!sameSpec(record.spec, spec)) {
      return Promise.reject(new PermanentTunnelError(`SSH tunnel route changed for ${spec.device}; restart the server`));
    }
    // Trust 'running' only while the child that earned it is still alive. A state machine that
    // believes in a tunnel it no longer owns answers every later ensure() with resolve(), and the
    // device never comes back — so re-derive liveness from the process instead.
    if (record.state === 'running' && hasLiveChild(record)) return Promise.resolve();
    if (record.ensurePromise) return record.ensurePromise;
    record.ensurePromise = this.start(record).finally(() => { record.ensurePromise = null; });
    return record.ensurePromise;
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.records.values()].map((record) => this.stopRecord(record)));
  }

  /**
   * Stop one device's tunnel for good: kill the child, cancel the retry chain, and forget the
   * frozen route so a machine registered again under that name starts from its new spec.
   */
  async release(device: string): Promise<void> {
    const record = this.records.get(device);
    if (!record) return;
    this.records.delete(device);
    await this.stopRecord(record);
  }

  private getOrCreate(spec: SshTunnelSpec): TunnelRecord {
    const existing = this.records.get(spec.device);
    if (existing) return existing;
    const record: TunnelRecord = {
      spec: { ...spec }, state: 'stopped', generation: 0, child: null,
      ensurePromise: null, retryTimer: null, attempt: 0, lastError: null,
    };
    this.records.set(spec.device, record);
    return record;
  }

  private controlPath(spec: SshTunnelSpec): string {
    fs.mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(`${spec.device}\0${spec.host}`).digest('hex').slice(0, 20);
    return path.join(this.controlDir, `${key}.sock`);
  }

  private controlArgs(record: TunnelRecord, operation: 'check' | 'exit'): string[] {
    return ['-S', this.controlPath(record.spec), '-O', operation, record.spec.host];
  }

  private async closeStaleMaster(record: TunnelRecord): Promise<void> {
    const socket = this.controlPath(record.spec);
    try {
      await this.execSsh(this.controlArgs(record, 'exit'), 3000);
      await delay(50);
    } catch {
      try { fs.unlinkSync(socket); } catch {}
    }
  }

  private async freeRemotePort(record: TunnelRecord): Promise<void> {
    const command = record.spec.freeRemotePortCommand;
    if (!command) return;
    try {
      await this.execSsh([...SSH_BASE_OPTIONS, record.spec.host, command], 15_000);
    } catch (error) {
      // Best effort: a reachable-but-uncooperative host should still get a tunnel attempt, and an
      // unreachable one fails loudly a moment later on the spawn itself.
      log.warn(`${record.spec.device}: could not free remote port ${record.spec.remotePort}: ${(error as Error).message}`);
    }
  }

  private async start(record: TunnelRecord): Promise<void> {
    const generation = ++record.generation;
    record.state = 'starting';
    record.lastError = null;
    await this.closeStaleMaster(record);
    await this.freeRemotePort(record);
    if (!this.isCurrent(record, generation) || this.stopping) throw new Error('SSH tunnel start cancelled');
    const child = this.spawnSsh(buildSshTunnelArgs(record.spec, this.controlPath(record.spec)));
    record.child = child;
    this.attachChild(record, child, generation);
    await this.waitUntilReady(record, generation);
    // `-O check` can succeed in the same tick the child dies of a rejected forward, so the
    // readiness probe alone does not prove we still own a tunnel. Confirm the child we spawned is
    // still the record's child before declaring 'running' — otherwise we would overwrite the
    // 'backoff' that fail() just set and strand the retry that came with it.
    if (!this.isCurrent(record, generation) || record.child !== child) {
      throw record.lastError ?? new Error('SSH tunnel start superseded');
    }
    record.state = 'running';
    record.attempt = 0;
    log.info(`SSH reverse tunnel ready for ${record.spec.device} on remote port ${record.spec.remotePort}`);
  }

  private attachChild(record: TunnelRecord, child: ChildProcess, generation: number): void {
    child.once('error', (error) => this.fail(record, child, generation, error));
    child.once('exit', (code, signal) => {
      this.fail(record, child, generation, new Error(`SSH tunnel exited (${signal ?? code ?? 'unknown'})`));
    });
  }

  private async waitUntilReady(record: TunnelRecord, generation: number): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.isCurrent(record, generation)) throw record.lastError ?? new Error('SSH tunnel start failed');
      try {
        await this.execSsh(this.controlArgs(record, 'check'), 2000);
        return;
      } catch {
        await delay(this.readyPollMs);
      }
    }
    const error = new Error(`SSH tunnel for ${record.spec.device} was not ready within ${this.readyTimeoutMs}ms`);
    this.fail(record, record.child, generation, error);
    try { record.child?.kill('SIGTERM'); } catch {}
    throw error;
  }

  private isCurrent(record: TunnelRecord, generation: number): boolean {
    // 'backoff' counts as superseded: fail() has already disowned the child and armed a retry, so
    // an in-flight start() must abort rather than race that retry back to 'running'.
    return record.generation === generation && (record.state === 'starting' || record.state === 'running');
  }

  private fail(record: TunnelRecord, child: ChildProcess | null, generation: number, error: Error): void {
    if (record.generation !== generation || record.child !== child) return;
    if (record.state === 'stopping' || record.state === 'stopped') return;
    record.child = null;
    record.lastError = error;
    record.state = 'backoff';
    log.warn(`${record.spec.device}: ${error.message}`);
    this.scheduleRetry(record);
  }

  private scheduleRetry(record: TunnelRecord): void {
    if (this.stopping || record.retryTimer) return;
    if (record.state === 'stopping' || record.state === 'stopped') return;
    const wait = Math.min(this.retryBaseMs * (2 ** record.attempt), this.retryMaxMs);
    record.attempt += 1;
    record.retryTimer = setTimeout(() => {
      record.retryTimer = null;
      if (this.stopping) return;
      void this.ensure(record.spec).catch((error) => {
        log.warn(`${record.spec.device}: tunnel retry failed: ${(error as Error).message}`);
        // Not every rejection routes through fail() — a start() that aborts as superseded throws
        // without arming anything. Re-arm here or that one rejection ends the retry chain and the
        // device is offline until the next server restart.
        if (!(error instanceof PermanentTunnelError)) this.scheduleRetry(record);
      });
    }, wait);
  }

  private async stopRecord(record: TunnelRecord): Promise<void> {
    record.generation += 1;
    record.state = 'stopping';
    if (record.retryTimer) clearTimeout(record.retryTimer);
    record.retryTimer = null;
    const child = record.child;
    record.child = null;
    try { await this.execSsh(this.controlArgs(record, 'exit'), 3000); } catch {}
    if (child) await this.stopChild(child);
    record.state = 'stopped';
    record.ensurePromise = null;
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try { child.kill('SIGTERM'); } catch { return; }
    const timedOut = await Promise.race([exited.then(() => false), delay(this.stopTimeoutMs).then(() => true)]);
    if (!timedOut) return;
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([exited, delay(this.stopTimeoutMs)]);
  }
}
