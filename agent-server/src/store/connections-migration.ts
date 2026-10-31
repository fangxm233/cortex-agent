// The step that retires gateway modes for connections: every credential the gateway era kept in
// gateway.yaml, config/.env or PI's catalog becomes an entry of config/connections.json, and every
// stored selection names a connection instead of a mode. Every file it changes is copied to an
// archive first — config files under config/archive/, state under data/archive/ — and gateway.yaml
// is only copied, never changed. Idempotent: an existing connection is never replaced, and a
// converted file has nothing left to convert.

import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { atomicWrite, mutateFileAtomically } from '@core/atomic-write.js';
import { connectionKey, readConnections, writeConnections } from '@core/connections-file.js';
import { readGatewayYaml } from '@core/gateway-generator.js';
import { createLogger } from '@core/log.js';
import { planConnections, type ConnectionsPlan, type LegacySources } from './connections-migration-sources.js';
import {
  convertAgentState, convertModelsFile, convertPendingInjections, convertProviderState, convertSchedules,
} from './connections-migration-selections.js';
import { SessionRegistryRepo } from './session-registry-repo.js';

const log = createLogger('connections-migration');
type Json = Record<string, unknown>;

export interface ConnectionsMigrationOptions {
  /** The Cortex home; its config/ holds connections.json, .env and models.json. */
  homeDir: string;
  /** The Cortex data dir. */
  storeDir: string;
  gatewayPath: string;
  /** PI's user catalog (`~/.pi/agent/models.json`). */
  piModelsPath: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface ConnectionsMigrationReport {
  skipped?: 'immutable';
  /** `backend:id` of every connection added. */
  added: string[];
  skippedRoutes: ConnectionsPlan['skipped'];
  retiredPiEntries: string[];
  retiredDotenvKeys: string[];
  /** Selections renamed outside the session registry. */
  selections: number;
  /** Whether the session registry was rewritten without its gateway-era selections. */
  registryRewritten: boolean;
  /** Every file copied aside, by its archive path. */
  archived: string[];
}

function emptyReport(): ConnectionsMigrationReport {
  return { added: [], skippedRoutes: [], retiredPiEntries: [], retiredDotenvKeys: [], selections: 0,
    registryRewritten: false, archived: [] };
}

function isJson(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** A JSON object file; a missing file is null, and so is a corrupt one: its own reader ignores it. */
async function readJsonObject(file: string): Promise<Json | null> {
  const raw = await readOptional(file);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJson(parsed) ? parsed : null;
  } catch {
    log.warn(`Leaving unparseable ${path.basename(file)} as it is`);
    return null;
  }
}

async function fileMode(file: string): Promise<number> {
  return (await fs.stat(file)).mode & 0o777;
}

async function writeJsonKeepingMode(file: string, document: Json): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(document, null, 2)}\n`, { mode: await fileMode(file) });
}

/** Copies files aside before they change. Owner-only: several of them carry keys. */
class Archive {
  constructor(private readonly stamp: string, private readonly report: ConnectionsMigrationReport) {}

  async keep(file: string, root: string, name = path.basename(file)): Promise<void> {
    const dir = path.join(root, 'archive', `connections-${this.stamp}`);
    const destination = path.join(dir, name);
    if (this.report.archived.includes(destination) || await readOptional(file) === null) return;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.copyFile(file, destination, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      // An earlier attempt with the same stamp already kept it: never overwrite an archive.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return;
    }
    await fs.chmod(destination, 0o600);
    this.report.archived.push(destination);
  }
}

async function readSources(options: ConnectionsMigrationOptions): Promise<LegacySources> {
  const dotenv = await readOptional(path.join(options.homeDir, 'config', '.env'));
  const piCatalog = await readJsonObject(options.piModelsPath);
  return {
    endpoints: readGatewayYaml(options.gatewayPath)?.endpoints ?? null,
    dotenv: dotenv ? parseDotenv(dotenv) : {},
    env: options.env ?? process.env,
    piProviders: isJson(piCatalog?.providers) ? piCatalog.providers : {},
  };
}

/** Rewrite one JSON document through `convert`, archiving it first; returns the selections changed. */
async function convertJson(
  file: string, convert: (document: Json) => number, keep: (file: string) => Promise<void>,
): Promise<number> {
  const document = await readJsonObject(file);
  const changed = document ? convert(document) : 0;
  if (!document || changed === 0) return 0;
  await keep(file);
  await writeJsonKeepingMode(file, document);
  return changed;
}

async function convertStoredSelections(options: ConnectionsMigrationOptions, archive: Archive): Promise<number> {
  const keepData = (file: string) => archive.keep(file, options.storeDir);
  const keepConfig = (file: string) => archive.keep(file, path.join(options.homeDir, 'config'));
  const data = (name: string) => path.join(options.storeDir, name);
  const counts = await Promise.all([
    convertJson(data('agent-state.json'), convertAgentState, keepData),
    convertJson(data('schedules.json'), convertSchedules, keepData),
    convertJson(data('pending-injections.json'), convertPendingInjections, keepData),
    convertJson(data('provider-state.json'), convertProviderState, keepData),
    convertJson(path.join(options.homeDir, 'config', 'models.json'), convertModelsFile, keepConfig),
  ]);
  return counts.reduce((sum, count) => sum + count, 0);
}

/** The registry is append-only, and its reader already renames a gateway-era selection; compacting
 *  it once writes every row back in the current shape. */
async function rewriteRegistry(options: ConnectionsMigrationOptions, archive: Archive): Promise<boolean> {
  const file = path.join(options.storeDir, 'session-registry.jsonl');
  const raw = await readOptional(file);
  if (!raw?.includes('"mode":')) return false;
  await archive.keep(file, options.storeDir);
  await new SessionRegistryRepo(file, { shouldCompact: () => false }).compactNow();
  return true;
}

async function retirePiEntries(options: ConnectionsMigrationOptions, names: string[], archive: Archive): Promise<void> {
  const catalog = names.length > 0 ? await readJsonObject(options.piModelsPath) : null;
  if (!catalog || !isJson(catalog.providers)) return;
  await archive.keep(options.piModelsPath, path.join(options.homeDir, 'config'), 'pi-models.json');
  for (const name of names) delete catalog.providers[name];
  await writeJsonKeepingMode(options.piModelsPath, catalog);
}

function withoutVariable(contents: string, name: string): string {
  return contents.replace(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*(?:\\r?\\n|$)`, 'gm'), '');
}

async function retireDotenvKeys(options: ConnectionsMigrationOptions, names: string[], archive: Archive): Promise<void> {
  if (names.length === 0) return;
  const file = path.join(options.homeDir, 'config', '.env');
  await archive.keep(file, path.join(options.homeDir, 'config'), 'env');
  await mutateFileAtomically(file, (contents) => names.reduce(withoutVariable, contents), { mode: 0o600 });
}

/** Write the connections first: nothing that held a key is retired before its connection exists. */
async function applyPlan(
  plan: ConnectionsPlan, options: ConnectionsMigrationOptions, archive: Archive,
): Promise<void> {
  const file = path.join(options.homeDir, 'config', 'connections.json');
  if (plan.connections.length > 0) writeConnections([...readConnections(file), ...plan.connections], file);
  await retirePiEntries(options, plan.retiredPiEntries, archive);
  await retireDotenvKeys(options, plan.retiredDotenvKeys, archive);
}

export async function migrateToConnections(options: ConnectionsMigrationOptions): Promise<ConnectionsMigrationReport> {
  const report = emptyReport();
  if (process.env.CORTEX_CONFIG_IMMUTABLE === '1') return { ...report, skipped: 'immutable' };
  const archive = new Archive((options.now ?? new Date()).toISOString().replace(/[-:.]/g, ''), report);
  const existing = readConnections(path.join(options.homeDir, 'config', 'connections.json'));
  const plan = planConnections(await readSources(options), existing);
  await archive.keep(options.gatewayPath, path.join(options.homeDir, 'config'));
  await applyPlan(plan, options, archive);
  report.selections = await convertStoredSelections(options, archive);
  report.registryRewritten = await rewriteRegistry(options, archive);
  Object.assign(report, {
    added: plan.connections.map(connectionKey), skippedRoutes: plan.skipped,
    retiredPiEntries: plan.retiredPiEntries, retiredDotenvKeys: plan.retiredDotenvKeys,
  });
  log.info(`Connections migration: ${JSON.stringify({ ...report, archived: report.archived.length })}`);
  return report;
}
