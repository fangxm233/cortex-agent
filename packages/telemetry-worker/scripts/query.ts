/**
 * Canned telemetry reports against D1 through `wrangler d1 execute`.
 *   pnpm -C packages/telemetry-worker query -- <report> [options]   (see --help)
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Row } from '../src/env.js';
import { INSTALL_TABLES, REPORT_NAMES, REPORTS, reportFilter, type Query, type ReportName } from '../src/reports.js';
import { CliError, printJson, readInput, runMain } from './cli.js';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HELP = `Usage: pnpm -C packages/telemetry-worker query -- <command> [options]

Commands:
  <report>         One canned report (list them with: list)
  list             Report names and descriptions
  install          Every stored row of one install          (--install-id)
  delete-install   Delete every stored row of one install   (--install-id, --dry-run)
  sql              Run your own SQL                          (--sql-file <path|->)

Options:
  --remote             Query the deployed database (default: local wrangler state)
  --config <file>      Wrangler config (default: wrangler.toml; wrangler.local.toml for --remote)
  --database <name>    D1 database name (default: cortex-telemetry)
  --days <n>           Report window in days, 7-365 (default: 30)
  --dev                Include channel=dev installs (default: release only)
  --install-id <uuid>  Install for install / delete-install
  --sql-file <path|->  SQL for the sql command; - reads stdin
  --dry-run            delete-install: report what would be deleted, delete nothing
  --table              Print rows as a table instead of JSON
  -h, --help           This help

Examples:
  pnpm -C packages/telemetry-worker query -- crashGroups --days 7
  pnpm -C packages/telemetry-worker query -- turnHealth --remote --config wrangler.local.toml --table
  pnpm -C packages/telemetry-worker query -- delete-install --install-id 6f1c2b8e-3d4a-4b5c-8d9e-0a1b2c3d4e5f --remote --config wrangler.local.toml --dry-run
  echo "SELECT COUNT(*) AS n FROM installs" | pnpm -C packages/telemetry-worker query -- sql --sql-file -`;

interface Options {
  remote: boolean;
  config: string;
  database: string;
  days: number;
  dev: boolean;
  installId?: string;
  sqlFile?: string;
  dryRun: boolean;
  table: boolean;
}

function sqlLiteral(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`Cannot inline SQL parameter: ${String(value)}`);
}

/** `wrangler d1 execute --command` takes no bindings, so parameters are inlined as literals. */
export function inlineParams(query: Query): string {
  let index = 0;
  const sql = query.sql.replace(/\?/g, () => sqlLiteral(query.params[index++]));
  if (index !== query.params.length) throw new Error(`Query has ${index} placeholders for ${query.params.length} parameters`);
  return sql;
}

function wranglerBin(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
}

/** Rows per statement of `sql`. */
function executeD1(sql: string, options: Options): Row[][] {
  const args = [wranglerBin(), 'd1', 'execute', options.database, options.remote ? '--remote' : '--local',
    '--json', '--config', options.config, '--command', sql];
  const result = spawnSync(process.execPath, args, { cwd: PACKAGE_DIR, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`wrangler d1 execute failed:\n${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout) as Array<{ results?: Row[] }>;
  return parsed.map(entry => entry.results ?? []);
}

function output(options: Options, result: Record<string, unknown> & { rows?: Row[] }): void {
  if (options.table && result.rows) console.table(result.rows);
  else printJson({ ok: true, ...result });
}

function requireInstallId(options: Options): string {
  if (options.installId && UUID.test(options.installId)) return options.installId;
  throw new CliError(`Invalid --install-id: '${options.installId ?? ''}'.`, 'Pass the UUID shown in Cortex settings, e.g. --install-id 6f1c2b8e-3d4a-4b5c-8d9e-0a1b2c3d4e5f');
}

function installRows(options: Options): Record<string, unknown> {
  const id = sqlLiteral(requireInstallId(options));
  const results = executeD1(INSTALL_TABLES.map(table => `SELECT * FROM ${table} WHERE install_id = ${id}`).join(';\n'), options);
  return { install_id: options.installId, tables: Object.fromEntries(INSTALL_TABLES.map((table, i) => [table, results[i]])) };
}

function deleteInstall(options: Options): Record<string, unknown> {
  const id = sqlLiteral(requireInstallId(options));
  const counts = executeD1(INSTALL_TABLES.map(table => `SELECT COUNT(*) AS n FROM ${table} WHERE install_id = ${id}`).join(';\n'), options);
  const rows = Object.fromEntries(INSTALL_TABLES.map((table, i) => [table, Number(counts[i][0]?.n ?? 0)]));
  if (options.dryRun) return { dry_run: true, install_id: options.installId, would_delete: rows };
  executeD1(INSTALL_TABLES.map(table => `DELETE FROM ${table} WHERE install_id = ${id}`).join(';\n'), options);
  return { install_id: options.installId, deleted: rows, deleted_at: new Date().toISOString() };
}

function runReport(name: ReportName, options: Options): Record<string, unknown> {
  const filter = reportFilter(new Date(), options.days, options.dev);
  const rows = executeD1(inlineParams(REPORTS[name].build(filter)), options)[0] ?? [];
  return { report: name, since: filter.since, until: filter.today, channels: [...new Set(filter.channels)], rows };
}

const COMMANDS: Record<string, (options: Options) => Record<string, unknown>> = {
  list: () => ({ reports: Object.fromEntries(REPORT_NAMES.map(name => [name, REPORTS[name].description])) }),
  install: installRows,
  'delete-install': deleteInstall,
  sql: options => {
    if (!options.sqlFile) throw new CliError('The sql command needs --sql-file <path|->.');
    return { rows: executeD1(readInput(options.sqlFile), options).at(-1) ?? [] };
  },
};

function parseOptions(argv: string[]): { command?: string; help: boolean; options: Options } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      remote: { type: 'boolean', default: false }, local: { type: 'boolean', default: false },
      config: { type: 'string' }, database: { type: 'string', default: 'cortex-telemetry' },
      days: { type: 'string', default: '30' }, dev: { type: 'boolean', default: false },
      'install-id': { type: 'string' }, 'sql-file': { type: 'string' },
      'dry-run': { type: 'boolean', default: false }, table: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const options: Options = {
    remote: values.remote, config: values.config ?? 'wrangler.toml', database: values.database,
    days: Number(values.days), dev: values.dev, installId: values['install-id'], sqlFile: values['sql-file'],
    dryRun: values['dry-run'], table: values.table,
  };
  return { command: positionals[0], help: values.help, options };
}

async function main(argv: string[]): Promise<void> {
  const { command, help, options } = parseOptions(argv);
  if (help || !command) return void process.stdout.write(`${HELP}\n`);
  const handler = COMMANDS[command] ?? (REPORT_NAMES.includes(command as ReportName)
    ? (opts: Options) => runReport(command as ReportName, opts) : undefined);
  if (!handler) {
    throw new CliError(`Unknown command: '${command}'.`, `Available: ${[...Object.keys(COMMANDS), ...REPORT_NAMES].join(', ')}`);
  }
  output(options, handler(options));
}

runMain(import.meta.url, main);
