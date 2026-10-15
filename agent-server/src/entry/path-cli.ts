import { formatError, type CliResult } from '@core/cli-utils.js';
import { getResolvedPaths } from './init.js';
import { getPathHelp } from './cli-help.js';
import {
  defaultTerminalCliContext, installTerminalCli, removeTerminalCli, terminalCliStatus, type TerminalCliContext,
} from '@domain/system/terminal-cli/index.js';

const SUBCOMMANDS = ['install', 'remove', 'status'];

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : undefined;
}

const fail = (message: string): CliResult => ({
  exitCode: 1, stdout: '', stderr: formatError(message, { validValues: SUBCOMMANDS, hint: 'cortex path --help' }),
});

type Report = Record<string, unknown> & { dir: string; path_targets: Array<{ target: string; changed?: boolean; registered?: boolean }> };

function targetsLine(report: Report, key: 'changed' | 'registered', label: string): string {
  const hits = report.path_targets.filter((t) => t[key]).map((t) => t.target);
  return `${label}: ${hits.length ? hits.join(', ') : 'none'}`;
}

function installText(report: ReturnType<typeof installTerminalCli>): string[] {
  const lines = [
    `${report.dry_run ? 'Would install' : 'Installed'} terminal commands in ${report.dir}`,
    targetsLine(report, 'changed', report.dry_run ? 'PATH would change in' : 'PATH updated in'),
    'Open a new terminal to use `cortex`.',
  ];
  if (report.shadowed.length) lines.push(`New terminals will use this install instead of: ${report.shadowed.join(', ')}`);
  if (process.env.SHELL?.endsWith('fish')) lines.push(`fish is not configured automatically; run: fish_add_path ${report.dir}`);
  return lines;
}

function removeText(report: ReturnType<typeof removeTerminalCli>): string[] {
  return [
    `${report.dry_run ? 'Would remove' : 'Removed'} ${report.removed.length} command file(s) from ${report.dir}`,
    targetsLine(report, 'changed', report.dry_run ? 'PATH would change in' : 'PATH restored in'),
  ];
}

function statusText(report: ReturnType<typeof terminalCliStatus>): string[] {
  return [
    `Terminal commands: ${report.installed ? 'installed' : 'not installed'} (${report.dir})`,
    ...(report.stale.length ? [`Out of date: ${report.stale.join(', ')} — rerun cortex path install`] : []),
    targetsLine(report, 'registered', 'On PATH via'),
  ];
}

const ACTIONS: Record<string, (ctx: TerminalCliContext, dryRun: boolean) => { report: any; text: string[] }> = {
  install: (ctx, dryRun) => { const report = installTerminalCli(ctx, dryRun); return { report, text: installText(report) }; },
  remove: (ctx, dryRun) => { const report = removeTerminalCli(ctx, dryRun); return { report, text: removeText(report) }; },
  status: (ctx) => { const report = terminalCliStatus(ctx); return { report, text: statusText(report) }; },
};

/** `cortex path install|remove|status` — make this install's commands reachable from terminals. */
export function runPathCli(args: string[], makeContext = defaultTerminalCliContext): CliResult {
  if (args.includes('--help') || args.includes('-h')) return { exitCode: 0, stdout: getPathHelp(), stderr: '' };
  if (args.length === 0) return fail("Missing subcommand for 'path'.");
  const action = ACTIONS[args[0]];
  if (!action) return fail(`Unknown subcommand: '${args[0]}'.`);
  try {
    const ctx = makeContext(getResolvedPaths(optionValue(args, '--home')).DATA_DIR);
    const { report, text } = action(ctx, args.includes('--dry-run'));
    const stdout = args.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : `${text.join('\n')}\n`;
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error: any) {
    return { exitCode: 1, stdout: '', stderr: `cortex path ${args[0]} failed: ${error?.message ?? String(error)}\n` };
  }
}
