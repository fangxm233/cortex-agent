import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtinLayerEnabled } from '../core/builtin-layer.js';
import type { HookProcessOptions } from '../core/hook-exec.js';
import { hookScriptArgs, type HookScriptDirs } from '../core/hook-scripts.js';
import { CONFIG_DIR, DEFAULTS_DIR } from '../core/paths.js';

export type HookBackend = 'claude' | 'pi';
export type AgentHookEvent =
  | 'agent:pre-tool'
  | 'agent:post-tool'
  | 'agent:session-start'
  | 'agent:session-end'
  | 'agent:pre-compact'
  | 'agent:user-prompt'
  | 'agent:turn-end';
export type HookEvent = AgentHookEvent | `cc:${string}` | `pi:${string}` | `cortex:${string}`;
export type HookRun = (
  | { script: string; command?: never }
  | { command: string; script?: never }
) & { timeout?: number };
export type HookFilterValue = string | number | boolean | null;
export type HookResultMode = 'hook-result' | 'stdout-as-prompt' | 'none';

export interface HookEntry {
  id: string;
  event: HookEvent;
  matcher?: string | Record<string, HookFilterValue>;
  run: HookRun;
  scope?: {
    backends?: HookBackend[];
    requiresTool?: string;
  };
  blocking?: {
    mode: 'webhook';
    ttlMin: number;
  };
  result?: HookResultMode;
  enabled?: boolean;
  version?: string;
}

export interface HookFilterCriteria {
  event?: HookEvent;
  backend?: HookBackend;
  availableTools?: ReadonlySet<string>;
}

/** `builtin`: shipped with Cortex (possibly with a user override); `user`: the user's own entry. */
export const HOOK_SOURCES = ['builtin', 'user'] as const;
export type HookSource = typeof HOOK_SOURCES[number];

/** The shipped registrations, read in place. */
export const BUILTIN_HOOK_REGISTRY_DIR = path.join(DEFAULTS_DIR, 'config', 'hooks');

export interface HookRegistryDirs {
  /** The user's registrations. A file named like a built-in is a partial override merged over it. */
  user: string;
  /** The shipped registrations; null in a sealed home, which mounts only its own entries. */
  builtin: string | null;
}

export function defaultHookRegistryDirs(): HookRegistryDirs {
  return { user: path.join(CONFIG_DIR, 'hooks'), builtin: builtinLayerEnabled() ? BUILTIN_HOOK_REGISTRY_DIR : null };
}

export interface BuiltinHookLayer {
  /** The shipped entry as it ships. */
  entry: HookEntry;
  /** Where the user's override of it lives (present or not). */
  overridePath: string;
  /** The override's fields, or null when there is none. */
  override: Record<string, unknown> | null;
}

export interface HookRegistryRecord {
  /** The entry in effect: the user's own, or the shipped one with the override merged over it. */
  entry: HookEntry;
  /** The file in effect: the user's file when there is one, otherwise the shipped file. */
  filePath: string;
  source: HookSource;
  /** Present for a built-in entry. */
  builtin?: BuiltinHookLayer;
}

export interface MountedHookSummary {
  id: string;
  event: HookEntry['event'];
  enabled: boolean;
  source: HookSource;
  /** A built-in entry the user has changed (today: switched off or on). */
  overridden: boolean;
}

export interface RegistryHook extends MountedHookSummary {
  kind: 'registry';
  entry: HookEntry;
  filePath: string;
}

export type MountedHook = RegistryHook;

const AGENT_EVENTS = new Set([
  'agent:pre-tool',
  'agent:post-tool',
  'agent:session-start',
  'agent:session-end',
  'agent:pre-compact',
  'agent:user-prompt',
  'agent:turn-end',
]);
const CALVER_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/;
const RESULT_MODES = new Set<HookResultMode>(['hook-result', 'stdout-as-prompt', 'none']);
export const RESULT_CAPABILITY_BY_EVENT: ReadonlyMap<
  HookEvent,
  Exclude<HookResultMode, 'none'>
> = new Map([
  ['cortex:thread.start', 'hook-result'],
  ['cortex:thread.transition', 'hook-result'],
  ['cortex:thread.end', 'hook-result'],
  ['cortex:session.new', 'stdout-as-prompt'],
  ['cortex:session.messageEnd', 'stdout-as-prompt'],
]);

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validateEvent(value: unknown): HookEvent {
  const event = nonEmptyString(value, 'event');
  if (AGENT_EVENTS.has(event)) return event as HookEvent;
  const nativeEvent = event.match(/^(?:cc|pi|cortex):(.*)$/s);
  if (nativeEvent?.[1].trim()) return event as HookEvent;
  throw new Error(`unsupported hook event "${event}"`);
}

function isFilterValue(value: unknown): value is HookFilterValue {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function validateRegexMatcher(value: unknown, id: string): void {
  if (typeof value !== 'string') throw new Error(`${id}: matcher must be a string`);
  try {
    new RegExp(value);
  } catch {
    throw new Error(`${id}: matcher must be a valid regular expression`);
  }
}

function validateCortexMatcher(value: unknown, id: string): void {
  let matcher: Record<string, unknown>;
  try {
    matcher = asObject(value, 'matcher');
  } catch {
    throw new Error(`${id}: matcher must be an object`);
  }
  if (!Object.values(matcher).every(isFilterValue)) {
    throw new Error(`${id}: matcher values must be primitive`);
  }
}

function validateMatcher(value: unknown, event: HookEvent, id: string): void {
  if (value === undefined) return;
  if (event.startsWith('cortex:')) validateCortexMatcher(value, id);
  else validateRegexMatcher(value, id);
}

function validateScript(value: unknown): void {
  const script = nonEmptyString(value, 'run.script');
  const escapes = script.split(/[\\/]/).includes('..');
  if (path.isAbsolute(script) || path.win32.isAbsolute(script) || escapes) {
    throw new Error('run.script must stay relative to the hooks directory');
  }
}

function validateTimeout(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('run.timeout must be a positive number');
  }
}

function validateRun(value: unknown): void {
  const run = asObject(value, 'run');
  const hasScript = run.script !== undefined;
  const hasCommand = run.command !== undefined;
  if (hasScript === hasCommand) throw new Error('run must contain exactly one of script or command');
  if (hasScript) validateScript(run.script);
  if (hasCommand) nonEmptyString(run.command, 'run.command');
  validateTimeout(run.timeout);
}

function validateBackends(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('scope.backends must be an array');
  if (!value.every((item) => item === 'claude' || item === 'pi')) {
    throw new Error('scope.backends contains an unsupported backend');
  }
}

function validateScope(value: unknown): void {
  if (value === undefined) return;
  const scope = asObject(value, 'scope');
  if (scope.backends !== undefined) validateBackends(scope.backends);
  if (scope.requiresTool !== undefined) nonEmptyString(scope.requiresTool, 'scope.requiresTool');
}

function validateBlocking(value: unknown): void {
  if (value === undefined) return;
  const blocking = asObject(value, 'blocking');
  if (blocking.mode !== 'webhook') throw new Error('blocking.mode must be webhook');
  if (typeof blocking.ttlMin !== 'number' || !Number.isFinite(blocking.ttlMin) || blocking.ttlMin <= 0) {
    throw new Error('blocking.ttlMin must be a positive number');
  }
}

function validateResult(value: unknown, event: HookEvent): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !RESULT_MODES.has(value as HookResultMode)) {
    throw new Error('result must be hook-result, stdout-as-prompt, or none');
  }
  if (value !== 'none' && RESULT_CAPABILITY_BY_EVENT.get(event) !== value) {
    throw new Error(`result mode "${value}" is not permitted for event "${event}"`);
  }
}

function validateOptionalFields(entry: Record<string, unknown>, event: HookEvent): void {
  validateScope(entry.scope);
  validateBlocking(entry.blocking);
  validateResult(entry.result, event);
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  if (entry.version !== undefined && !CALVER_RE.test(nonEmptyString(entry.version, 'version'))) {
    throw new Error('version must be a CalVer string');
  }
}

export function validateHookEntry(value: unknown): HookEntry {
  const entry = asObject(value, 'hook entry');
  const id = nonEmptyString(entry.id, 'id');
  const event = validateEvent(entry.event);
  validateMatcher(entry.matcher, event, id);
  validateRun(entry.run);
  validateOptionalFields(entry, event);
  return entry as unknown as HookEntry;
}

function reportInvalid(source: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[hook-registry] skipped ${source}: ${message}`);
}

function registryFiles(directory: string | null): Set<string> {
  if (!directory) return new Set();
  try {
    return new Set(fs.readdirSync(directory).filter((file) => file.endsWith('.json')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportInvalid(directory, error);
    return new Set();
  }
}

function readObject(filePath: string): Record<string, unknown> {
  return asObject(JSON.parse(fs.readFileSync(filePath, 'utf8')), 'hook entry');
}

/** The user's partial for a built-in, or null when it is absent or unreadable (reported). */
function readOverride(filePath: string, present: boolean): Record<string, unknown> | null {
  if (!present) return null;
  try {
    return readObject(filePath);
  } catch (error) {
    reportInvalid(path.basename(filePath), error);
    return null;
  }
}

/** A shipped entry with the user's partial laid over it. The id stays the shipped one. */
function builtinRecord(file: string, dirs: HookRegistryDirs, hasOverride: boolean): HookRegistryRecord {
  const shippedPath = path.join(dirs.builtin!, file);
  const shipped = validateHookEntry(readObject(shippedPath));
  const overridePath = path.join(dirs.user, file);
  const override = readOverride(overridePath, hasOverride);
  const entry = override ? validateHookEntry({ ...shipped, ...override, id: shipped.id }) : shipped;
  return {
    entry,
    filePath: override ? overridePath : shippedPath,
    source: 'builtin',
    builtin: { entry: shipped, overridePath, override },
  };
}

function userRecord(file: string, dirs: HookRegistryDirs): HookRegistryRecord {
  const filePath = path.join(dirs.user, file);
  return { entry: validateHookEntry(readObject(filePath)), filePath, source: 'user' };
}

/** Every registration, shipped and the user's, in file-name order. A user file named like a shipped
 *  one is merged over it (`{ "enabled": false }` switches a built-in off); other user files add. */
export function loadHookRegistryRecords(dirs: HookRegistryDirs = defaultHookRegistryDirs()): HookRegistryRecord[] {
  const shipped = registryFiles(dirs.builtin);
  const user = registryFiles(dirs.user);
  const records: HookRegistryRecord[] = [];
  const ids = new Set<string>();
  for (const file of [...new Set([...shipped, ...user])].sort()) {
    try {
      const record = shipped.has(file) ? builtinRecord(file, dirs, user.has(file)) : userRecord(file, dirs);
      if (ids.has(record.entry.id)) throw new Error(`duplicate hook id "${record.entry.id}"`);
      ids.add(record.entry.id);
      records.push(record);
    } catch (error) {
      reportInvalid(file, error);
    }
  }
  return records;
}

export function loadHookRegistry(dirs: HookRegistryDirs = defaultHookRegistryDirs()): HookEntry[] {
  return loadHookRegistryRecords(dirs).map((record) => record.entry);
}

function registryHook(record: HookRegistryRecord): RegistryHook {
  return {
    kind: 'registry',
    id: record.entry.id,
    event: record.entry.event,
    enabled: record.entry.enabled !== false,
    source: record.source,
    overridden: record.builtin?.override != null,
    entry: record.entry,
    filePath: record.filePath,
  };
}

export function loadMountedHooks(dirs: HookRegistryDirs = defaultHookRegistryDirs()): MountedHook[] {
  return loadHookRegistryRecords(dirs).map(registryHook);
}

export function summarizeMountedHook(hook: MountedHook): MountedHookSummary {
  return { id: hook.id, event: hook.event, enabled: hook.enabled, source: hook.source, overridden: hook.overridden };
}

export function loadMountedHookSummaries(dirs: HookRegistryDirs = defaultHookRegistryDirs()): MountedHookSummary[] {
  return loadMountedHooks(dirs).map(summarizeMountedHook);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * How to spawn one mounted hook for a manual test run (the cortex-hook CLI and the Web UI).
 * `maxTimeoutMs` lets a caller clamp the declared timeout.
 */
export function hookProcessOptions(
  hook: MountedHook,
  scriptDirs: HookScriptDirs,
  stdinPayload: string,
  maxTimeoutMs = Infinity,
): HookProcessOptions {
  const run = hook.entry.run;
  const command = run.script === undefined
    ? run.command
    : `node ${hookScriptArgs(run.script, scriptDirs).map(shellQuote).join(' ')}`;
  return {
    command,
    timeoutMs: Math.min((run.timeout ?? 30) * 1_000, maxTimeoutMs),
    stdinPayload,
    label: hook.id,
  };
}

function implicitBackends(event: HookEvent): HookBackend[] {
  if (event.startsWith('agent:')) return ['claude', 'pi'];
  if (event.startsWith('cc:')) return ['claude'];
  if (event.startsWith('pi:')) return ['pi'];
  return [];
}

/**
 * The backends an entry actually compiles to: the set implied by its event prefix, narrowed by an
 * explicit `scope.backends`. Exported so the UI can show mount targets without re-deriving the rule.
 */
export function effectiveHookBackends(entry: HookEntry): HookBackend[] {
  const implicit = implicitBackends(entry.event);
  const scoped = entry.scope?.backends;
  return scoped ? implicit.filter((backend) => scoped.includes(backend)) : implicit;
}

function matchesEvent(entry: HookEntry, criteria: HookFilterCriteria): boolean {
  return criteria.event === undefined || entry.event === criteria.event;
}

function matchesBackend(entry: HookEntry, criteria: HookFilterCriteria): boolean {
  return criteria.backend === undefined || effectiveHookBackends(entry).includes(criteria.backend);
}

function matchesTools(entry: HookEntry, criteria: HookFilterCriteria): boolean {
  const required = entry.scope?.requiresTool;
  return required === undefined || criteria.availableTools === undefined || criteria.availableTools.has(required);
}

export function filterHookEntries(
  entries: readonly HookEntry[],
  criteria: HookFilterCriteria = {},
): HookEntry[] {
  return entries
    .filter((entry) => entry.enabled !== false)
    .filter((entry) => matchesEvent(entry, criteria))
    .filter((entry) => matchesBackend(entry, criteria))
    .filter((entry) => matchesTools(entry, criteria));
}
