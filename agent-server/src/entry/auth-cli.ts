// input:  auth snapshot getter, shared formatter, localized CLI copy
// output: auth subcommand parser and result
// pos:    Authentication status CLI handler
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { formatError } from '@core/cli-utils.js';
import { t } from '@core/i18n.js';
import { formatAuthStatusSummary } from '@domain/auth/auth-format.js';
import type { AuthStatusSnapshot } from '@domain/auth/auth-status.js';
import type { CustomProviderStores } from '@domain/pi-providers/index.js';
import { getAuthHelp } from './cli-help.js';
import { runProviderCli } from './provider-cli.js';

export interface AuthCliDeps {
  getAuthStatus?: () => Promise<AuthStatusSnapshot>;
  /** Where custom PI providers are stored. Injected so the CLI states its own file paths. */
  customProviderStores?: CustomProviderStores;
}

export interface AuthCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function authErrorLabels() {
  return {
    validValues: t('cmd.auth.cli.validValues'),
    hint: t('cmd.auth.cli.hint'),
  };
}

function parseAuthCommand(args: string[]): AuthCliResult | string[] {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { exitCode: 0, stdout: getAuthHelp(), stderr: '' };
  }
  if (args[0] === 'status') return args.slice(1);
  const message = t('cmd.auth.cli.unknownSubcommand', { command: args[0] });
  const stderr = formatError(message, {
    validValues: ['status', 'provider'], hint: 'cortex auth --help', labels: authErrorLabels(),
  });
  return { exitCode: 1, stdout: '', stderr };
}

function validateAuthOptions(options: string[]): AuthCliResult | null {
  if (options.includes('--help') || options.includes('-h')) {
    return { exitCode: 0, stdout: getAuthHelp(), stderr: '' };
  }
  const invalid = options.find(option => option !== '--json');
  if (!invalid) return null;
  const message = t('cmd.auth.cli.unknownFlag', { flag: invalid });
  const stderr = formatError(message, {
    validValues: ['--json'], hint: 'cortex auth status --help', labels: authErrorLabels(),
  });
  return { exitCode: 1, stdout: '', stderr };
}

export async function runAuthCli(
  args: string[],
  readStatus: () => Promise<AuthStatusSnapshot>,
  stores?: CustomProviderStores,
): Promise<AuthCliResult> {
  // Custom providers are part of the account surface, so they hang off `cortex auth`.
  if (args[0] === 'provider') {
    if (!stores) {
      return { exitCode: 1, stdout: '', stderr: t('provider.cli.writeFailed') };
    }
    return runProviderCli(args.slice(1), stores);
  }
  const parsed = parseAuthCommand(args);
  if (!Array.isArray(parsed)) return parsed;
  const invalid = validateAuthOptions(parsed);
  if (invalid) return invalid;
  const snapshot = await readStatus();
  const stdout = parsed.includes('--json')
    ? JSON.stringify(snapshot, null, 2)
    : formatAuthStatusSummary(snapshot);
  return { exitCode: 0, stdout, stderr: '' };
}
