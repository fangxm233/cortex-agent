import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@core/atomic-write.js';
import { createLogger } from '@core/log.js';
import type { EngineSelection, ModelRef, ModelsFile } from '@domain/agents/engine-selection.js';
import { SessionRegistryRepo } from './session-registry-repo.js';

const log = createLogger('retire-profiles-migration');
type JsonObject = Record<string, unknown>;
type Memory = Record<string, Pick<EngineSelection, 'thinking' | 'mode'>>;

export interface RetireProfilesReport {
  skipped?: 'immutable' | 'no-profiles';
  profiles: number;
  favorites: number;
  channels: number;
  overrides: number;
  sessions: number;
  conversations: number;
  schedules: number;
  environments: number;
  archive?: string;
  missingNames: Array<{ name: string; context: string }>;
  discarded: Array<{ name: string; fields: string[] }>;
}

interface Snapshot {
  selections: Map<string, EngineSelection>;
  models: ModelsFile;
  memory: Memory;
  report: RetireProfilesReport;
}

function emptyReport(): RetireProfilesReport {
  return { profiles: 0, favorites: 0, channels: 0, overrides: 0, sessions: 0, conversations: 0,
    schedules: 0, environments: 0, missingNames: [], discarded: [] };
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readObject(file: string): Promise<JsonObject | null> {
  const raw = await readOptional(file);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${file}`);
  }
  return parsed as JsonObject;
}

async function writeObject(file: string, value: unknown): Promise<void> {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (await readOptional(file) !== next) await atomicWrite(file, next);
}

// Same model identity as modelKey; keep this store migration independent of domain runtime code.
function key(ref: ModelRef): string { return JSON.stringify([ref.backend, ref.provider, ref.model]); }

function profileSelection(name: string, raw: unknown): EngineSelection {
  const entry = object(raw);
  const backend = entry.backend ?? 'claude';
  if (backend !== 'claude' && backend !== 'pi') throw new Error(`Invalid backend for profile ${name}`);
  const model = text(entry.model);
  if (!model) throw new Error(`Missing model for profile ${name}`);
  const provider = backend === 'pi' ? text(entry.provider) ?? text(entry.mode) ?? 'anthropic' : null;
  const extra = object(entry.extraOption);
  return { backend, provider, model,
    thinking: text(entry.thinking) ?? text(extra['--thinking']) ?? text(extra['--effort']) ?? null,
    mode: backend === 'pi' ? provider! : text(entry.mode) ?? 'plan' };
}

function recordDiscarded(name: string, entry: unknown, report: RetireProfilesReport): void {
  const fields = ['fallback', 'extraEnv', 'maxOutputTokens'].filter(field => field in object(entry));
  if (!fields.length) return;
  report.discarded.push({ name, fields });
  log.info(`Discarding retired fields for profile ${name}: ${fields.join(', ')}`);
}

function buildSnapshot(source: JsonObject, report: RetireProfilesReport): Snapshot {
  const selections = new Map<string, EngineSelection>();
  const favorites = new Map<string, ModelRef>();
  const memory: Memory = {};
  for (const [name, entry] of Object.entries(object(source.profiles))) {
    const selection = profileSelection(name, entry);
    selections.set(name, selection);
    const { backend, provider, model, thinking, mode } = selection;
    favorites.set(key(selection), { backend, provider, model });
    memory[key(selection)] ??= { thinking, mode };
    recordDiscarded(name, entry, report);
  }
  const defaultSelection = selections.get(String(source.defaultProfile));
  if (!defaultSelection) throw new Error(`Default profile not found: ${String(source.defaultProfile)}`);
  const { thinking, mode } = defaultSelection;
  memory[key(defaultSelection)] = { thinking, mode };
  report.profiles = selections.size;
  report.favorites = favorites.size;
  return { selections, models: { default: defaultSelection, favorites: [...favorites.values()] }, memory, report };
}

function resolveName(snapshot: Snapshot, name: unknown, context: string): EngineSelection {
  if (!text(name) || name === '__active__') return { ...snapshot.models.default };
  const selected = snapshot.selections.get(String(name));
  if (selected) return { ...selected };
  snapshot.report.missingNames.push({ name: String(name), context });
  log.warn(`Unknown profile ${String(name)} at ${context}; using default selection`);
  return { ...snapshot.models.default };
}

function mergeOverride(selection: EngineSelection, raw: unknown): EngineSelection {
  const override = object(raw);
  const next = { ...selection };
  for (const field of ['model', 'mode'] as const) {
    const value = text(override[field]);
    if (value) next[field] = value;
  }
  if (override.thinking === null || text(override.thinking)) next.thinking = override.thinking as string | null;
  const provider = text(override.provider);
  if (next.backend === 'pi' && provider && provider !== next.provider) {
    next.provider = provider;
    next.mode = provider;
  }
  return next;
}

function migrateChannels(state: JsonObject, snapshot: Snapshot): JsonObject {
  const profiles = object(state.channelProfiles);
  const overrides = object(state.channelOverrides);
  const channels = new Set([...Object.keys(profiles), ...Object.keys(overrides)]);
  const selections = { ...object(state.channelSelections) };
  for (const channel of channels) {
    if (selections[channel]) continue;
    const base = resolveName(snapshot, profiles[channel] ?? state.activeProfile, `channel:${channel}`);
    selections[channel] = mergeOverride(base, overrides[channel]);
    snapshot.report.channels += 1;
    if (Object.keys(object(overrides[channel])).length) snapshot.report.overrides += 1;
  }
  return selections;
}

function migrateSeed(state: JsonObject, snapshot: Snapshot): unknown {
  const seed = object(state.selectionDefault);
  if (!state.selectionDefault || seed.backend) return state.selectionDefault;
  const selection = mergeOverride(resolveName(snapshot, seed.profileName ?? state.activeProfile, 'selectionDefault'), seed);
  return { ...selection, ...(text(seed.agentName) ? { agentName: seed.agentName } : {}) };
}

function migrateState(state: JsonObject, snapshot: Snapshot): JsonObject {
  const next: JsonObject = { ...state, channelSelections: migrateChannels(state, snapshot),
    modelMemory: { ...snapshot.memory, ...object(state.modelMemory) } };
  if ('selectionDefault' in state) next.selectionDefault = migrateSeed(state, snapshot);
  for (const field of ['activeProfile', 'channelProfiles', 'channelOverrides']) delete next[field];
  return next;
}

interface RawNames { sessions: Map<string, string>; conversations: Map<string, string> }

function applyName(names: Map<string, string>, id: string, fields: JsonObject): void {
  if (!('profileName' in fields)) return;
  const name = text(fields.profileName);
  if (name) names.set(id, name);
  else names.delete(id);
}

function replaySessionName(names: Map<string, string>, row: JsonObject): void {
  const id = String(row.id);
  if (row.op === 'put') {
    names.delete(id);
    applyName(names, id, object(row.record));
    return;
  }
  if (row.op === 'patch') {
    applyName(names, id, object(row.fields));
    if (Array.isArray(row.unset) && row.unset.includes('profileName')) names.delete(id);
    return;
  }
  if (row.op === 'delete-intent' || row.op === 'delete-commit') names.delete(id);
}

/** Read the committed raw lines BEFORE loading the repo: the new replay intentionally discards
 * profileName. An unterminated tail is not committed (the repo truncates it on load). */
async function readRawNames(file: string): Promise<RawNames> {
  const names: RawNames = { sessions: new Map(), conversations: new Map() };
  const raw = await readOptional(file);
  if (!raw) return names;
  const committed = raw.slice(0, raw.lastIndexOf('\n') + 1);
  for (const line of committed.split('\n').filter(line => line.trim())) {
    const row = object(JSON.parse(line));
    if (row.op !== 'conversation') { replaySessionName(names.sessions, row); continue; }
    const channel = String(row.channel);
    if (row.kind === 'clear') names.conversations.delete(channel);
    else applyName(names.conversations, channel, object(row.fields));
  }
  return names;
}

async function migrateRegistry(file: string, state: JsonObject, snapshot: Snapshot): Promise<void> {
  const names = await readRawNames(file);
  if (!names.sessions.size && !names.conversations.size) return;
  // Never use the singleton, and never compact away the raw names needed by a partial retry.
  const repo = new SessionRegistryRepo(file, { shouldCompact: () => false });
  const overrides = object(state.channelOverrides);
  for (const [id, name] of names.sessions) {
    const session = await repo.getById(id);
    if (!session || session.selection) continue;
    const selection = mergeOverride(resolveName(snapshot, name, `session:${id}`), overrides[session.channel]);
    await repo.updateSession(id, { selection });
    snapshot.report.sessions += 1;
  }
  for (const [channel, name] of names.conversations) {
    const header = await repo.getConversationHeader(channel);
    if (!header || header.selection) continue;
    const selection = mergeOverride(resolveName(snapshot, name, `conversation:${channel}`), overrides[channel]);
    await repo.setConversation(channel, { selection });
    snapshot.report.conversations += 1;
  }
  await repo.flush();
}

async function migrateSchedules(file: string, snapshot: Snapshot): Promise<void> {
  const schedules = await readObject(file);
  if (!schedules || !Array.isArray(schedules.tasks)) return;
  for (const raw of schedules.tasks) {
    const task = object(raw);
    if (!('profile' in task)) continue;
    task.selection ??= resolveName(snapshot, task.profile, `schedule:${String(task.id)}`);
    delete task.profile;
    snapshot.report.schedules += 1;
  }
  await writeObject(file, schedules);
}

async function listEnvironments(dir: string): Promise<string[]> {
  try { return (await fs.readdir(dir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function migrateEnvironments(dir: string, report: RetireProfilesReport): Promise<void> {
  for (const name of await listEnvironments(dir)) {
    const file = path.join(dir, name);
    const environment = await readObject(file);
    if (!environment || !('profile' in environment)) continue;
    delete environment.profile;
    await writeObject(file, environment);
    report.environments += 1;
  }
}

async function archiveProfiles(source: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const dir = path.join(path.dirname(source), 'archive', `profiles-${stamp}`);
  await fs.mkdir(dir, { recursive: true });
  const destination = path.join(dir, 'profiles.json');
  // Refuse to replace an older archive, including a dangling symlink.
  try {
    await fs.lstat(destination);
    throw new Error(`Archive target already exists: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.rename(source, destination);
  return destination;
}

/** S10 only. Registry migration finishes before removing channel overrides; archive is LAST.
 * Each destination preserves already materialized values, so any interrupted prefix can retry.
 * A sealed home is entirely untouched, including its mutable state. */
export async function retireProfiles(options: {
  dataDir: string; storeDir: string; now?: Date;
}): Promise<RetireProfilesReport> {
  const report = emptyReport();
  if (process.env.CORTEX_CONFIG_IMMUTABLE === '1') return { ...report, skipped: 'immutable' };
  const configDir = path.join(options.dataDir, 'config');
  const sourcePath = path.join(configDir, 'profiles.json');
  const source = await readObject(sourcePath);
  if (!source) return { ...report, skipped: 'no-profiles' };
  const snapshot = buildSnapshot(source, report);
  const statePath = path.join(options.storeDir, 'agent-state.json');
  const state = await readObject(statePath) ?? {};
  const nextState = migrateState(state, snapshot);
  const modelsPath = path.join(configDir, 'models.json');
  if (!await readObject(modelsPath)) await writeObject(modelsPath, snapshot.models);
  await migrateRegistry(path.join(options.storeDir, 'session-registry.jsonl'), state, snapshot);
  await migrateSchedules(path.join(options.storeDir, 'schedules.json'), snapshot);
  await migrateEnvironments(path.join(configDir, 'environments'), report);
  await writeObject(statePath, nextState);
  report.archive = await archiveProfiles(sourcePath, options.now ?? new Date());
  log.info(`Retired profiles: ${JSON.stringify(report)}`);
  return report;
}
