import { formatError, type CliResult } from '@core/cli-utils.js';
import { RemoveClientError, removeClient, type RemoteExec } from '@domain/remote/client-remove.js';
import { getResolvedPaths } from './init.js';
import { getClientHelp } from './cli-help.js';

const VALUE_FLAGS = ['--device', '--home'];
const BOOLEAN_FLAGS = ['--keep-remote', '--dry-run'];

function fail(message: string, validValues?: string[], hint = 'cortex client remove --help'): CliResult {
  return { exitCode: 1, stdout: '', stderr: formatError(message, { validValues, hint }) };
}

/** Parse `remove` flags, or return the CliResult explaining what is wrong with them. */
function parseRemoveFlags(args: string[]): Record<string, string | true> | CliResult {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (BOOLEAN_FLAGS.includes(arg)) { flags[arg] = true; continue; }
    if (!VALUE_FLAGS.includes(arg)) return fail(`Unknown option: '${arg}'.`, [...VALUE_FLAGS, ...BOOLEAN_FLAGS]);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) return fail(`Missing value for ${arg}.`);
    flags[arg] = value;
    i += 1;
  }
  return flags;
}

async function runRemove(args: string[], remoteExec?: RemoteExec): Promise<CliResult> {
  const flags = parseRemoveFlags(args);
  if ('exitCode' in flags) return flags as CliResult;
  if (typeof flags['--device'] !== 'string') return fail('Missing --device.', undefined, 'cortex client remove --device <name>');
  const paths = getResolvedPaths(flags['--home'] as string | undefined);
  try {
    const report = await removeClient({
      device: flags['--device'] as string,
      keepRemote: flags['--keep-remote'] === true,
      dryRun: flags['--dry-run'] === true,
    }, { configDir: paths.CONFIG_DIR, storeDir: paths.STORE_DIR, remoteExec });
    const warning = report.remote?.status === 'unreachable'
      ? `Warning: '${report.device}' was removed locally, but its machine could not be reached; the remote client was not uninstalled.`
      : '';
    return { exitCode: 0, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: warning };
  } catch (error) {
    if (error instanceof RemoveClientError) return fail(error.message, error.validValues, error.hint);
    return { exitCode: 1, stdout: '', stderr: (error as Error).message };
  }
}

/** `cortex client remove` — unregister a remote machine and uninstall its cortex-client. */
export async function runClientCli(args: string[], remoteExec?: RemoteExec): Promise<CliResult> {
  if (args.includes('--help') || args.includes('-h')) return { exitCode: 0, stdout: getClientHelp(), stderr: '' };
  if (args.length === 0) return fail("Missing subcommand for 'client'.", ['remove'], 'cortex client --help');
  if (args[0] !== 'remove') return fail(`Unknown subcommand: '${args[0]}'.`, ['remove'], 'cortex client --help');
  return runRemove(args.slice(1), remoteExec);
}
