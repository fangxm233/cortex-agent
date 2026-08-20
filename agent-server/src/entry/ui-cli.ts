// input:  ui subcommand arguments and the local-UI enablement module
// output: `cortex ui` command results in human or JSON form
// pos:    Local Web UI endpoint CLI handler
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { formatError } from '@core/cli-utils.js';
import { getResolvedPaths } from './init.js';
import { enableLocalUi } from './local-ui.js';
import { getUiHelp } from './cli-help.js';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Read the value following a flag, or undefined when the flag is absent. */
function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : undefined;
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
export async function runUiCli(args: string[]): Promise<CliResult> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    const noSubcommand = args.length === 0;
    return noSubcommand
      ? {
        exitCode: 1,
        stdout: '',
        stderr: formatError("Missing subcommand for 'ui'.", {
          validValues: ['enable'],
          hint: 'cortex ui --help',
        }),
      }
      : { exitCode: 0, stdout: getUiHelp(), stderr: '' };
  }

  if (args[0] !== 'enable') {
    return {
      exitCode: 1,
      stdout: '',
      stderr: formatError(`Unknown subcommand: '${args[0]}'.`, {
        validValues: ['enable'],
        hint: 'cortex ui --help',
      }),
    };
  }

  const asJson = args.includes('--json');
  const portRaw = optionValue(args, '--port');
  const port = portRaw === undefined ? undefined : Number(portRaw);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: formatError(`Invalid --port: '${portRaw}'.`, {
        validValues: ['an integer in 1-65535'],
        hint: 'cortex ui enable --port 3004',
      }),
    };
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
      'Connect the desktop app with the CORTEX_CLIENT_TOKEN from config/.env.',
    ];
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (error: any) {
    return { exitCode: 1, stdout: '', stderr: error.message || String(error) };
  }
}

