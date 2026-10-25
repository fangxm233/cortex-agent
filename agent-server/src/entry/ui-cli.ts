import * as path from 'node:path';
import { formatError, type CliResult } from '@core/cli-utils.js';
import { createPairingStore, PAIRING_CODE_TTL_MS, PAIRING_FILE_NAME } from '@platform/ui-http/ui-pairing.js';
import { getResolvedPaths } from './init.js';
import { enableLocalUi } from './local-ui.js';
import { getUiHelp } from './cli-help.js';

const SUBCOMMANDS = ['enable', 'pair'];

/** Read the value following a flag, or undefined when the flag is absent. */
function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : undefined;
}

function usageError(message: string, opts: { validValues: string[]; hint: string }): CliResult {
  return { exitCode: 1, stdout: '', stderr: formatError(message, opts) };
}

/**
 * `cortex ui enable` — make this install reachable by the Cortex desktop app.
 *
 * The native shell needs three things that a plain `cortex init` leaves off (the endpoint is
 * opt-in): the Web UI HTTP transport switched on, a port, and the shell's own origins allowed for
 * CORS. This wraps all three plus token generation into one idempotent command, so both the desktop
 * setup wizard and an operator repairing an older install use the same path.
 *
 * `changed` in the JSON output tells the caller whether a running daemon must be restarted: .env is
 * read at process start, so flipping it mid-flight has no effect until the server respawns.
 */
async function runEnable(args: string[]): Promise<CliResult> {
  const asJson = args.includes('--json');
  const portRaw = optionValue(args, '--port');
  const port = portRaw === undefined ? undefined : Number(portRaw);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return usageError(`Invalid --port: '${portRaw}'.`, {
      validValues: ['an integer in 1-65535'], hint: 'cortex ui enable --port 3004',
    });
  }

  const paths = getResolvedPaths(optionValue(args, '--home'));
  try {
    const result = await enableLocalUi({ configDir: paths.CONFIG_DIR, port });
    if (asJson) {
      const payload = { ok: true, home: paths.DATA_DIR, ...result };
      return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
    }
    const lines = [
      `Web UI endpoint enabled: ${result.url}`,
      `Home: ${paths.DATA_DIR}`,
      result.changed
        ? 'Configuration changed — restart the daemon to apply (cortex daemon restart).'
        : 'Already configured — no restart needed.',
      'Connect another app or browser with a one-time code from `cortex ui pair`.',
    ];
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (error: any) {
    return { exitCode: 1, stdout: '', stderr: error.message || String(error) };
  }
}

/**
 * `cortex ui pair` — mint a one-time pairing code for a new app or browser. It goes into the same
 * file the running server redeems from, so the server needs no restart.
 */
async function runPair(args: string[]): Promise<CliResult> {
  const paths = getResolvedPaths(optionValue(args, '--home'));
  const store = createPairingStore({ file: path.join(paths.STORE_DIR, PAIRING_FILE_NAME) });
  const { code, expiresAt } = store.create();
  if (args.includes('--json')) {
    return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, code, expiresAt }, null, 2)}\n`, stderr: '' };
  }
  const lines = [
    `Pairing code: ${code}`,
    `Valid for ${PAIRING_CODE_TTL_MS / 60_000} minutes, once.`,
    'Enter it with this server\'s address in the Cortex app, or on the browser sign-in page.',
  ];
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

const RUNNERS: Record<string, (args: string[]) => Promise<CliResult>> = { enable: runEnable, pair: runPair };

export async function runUiCli(args: string[]): Promise<CliResult> {
  if (args.length === 0) {
    return usageError("Missing subcommand for 'ui'.", { validValues: SUBCOMMANDS, hint: 'cortex ui --help' });
  }
  if (args.includes('--help') || args.includes('-h')) return { exitCode: 0, stdout: getUiHelp(), stderr: '' };
  const runner = Object.hasOwn(RUNNERS, args[0]) ? RUNNERS[args[0]] : undefined;
  if (!runner) {
    return usageError(`Unknown subcommand: '${args[0]}'.`, { validValues: SUBCOMMANDS, hint: 'cortex ui --help' });
  }
  return runner(args);
}
