// input:  hook registry/templates, filesystem, config paths
// output: event-capability-validated entries, mounted-hook loading, filtering API
// pos:    Declarative hook registry and mounted-state reader
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR } from '../core/paths.js';

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

export const HOOK_SOURCES = ['managed', 'user', 'template-scoped'] as const;
export type HookSource = typeof HOOK_SOURCES[number];

export interface HookRegistryRecord {
  entry: HookEntry;
  filePath: string;
  source: HookSource;
}

export type HookPhase = 'start' | 'transition' | 'end';

export interface MountedHookSummary {
  id: string;
  event: HookEntry['event'];
  enabled: boolean;
  source: HookSource;
}

export interface RegistryHook extends MountedHookSummary {
  kind: 'registry';
  entry: HookEntry;
  filePath: string;
}

export interface TemplateRun {
  command: string;
  args?: string[];
  timeout?: number;
}

export interface TemplateHook extends MountedHookSummary {
  kind: 'template';
  run: TemplateRun;
  template: string;
  phase: HookPhase;
}

export type MountedHook = RegistryHook | TemplateHook;

const TEMPLATE_PHASES: Array<{
  field: string;
  phase: HookPhase;
  event: HookEntry['event'];
}> = [
  { field: 'onStart', phase: 'start', event: 'cortex:thread.start' },
  { field: 'onTransition', phase: 'transition', event: 'cortex:thread.transition' },
  { field: 'onEnd', phase: 'end', event: 'cortex:thread.end' },
];

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

export function classifyHookSource(
  entry: { version?: unknown },
  location: 'registry' | 'template' = 'registry',
): HookSource {
  if (location === 'template') return 'template-scoped';
  return typeof entry.version === 'string' && CALVER_RE.test(entry.version)
    ? 'managed'
    : 'user';
}

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

function registryFiles(directory: string): string[] | null {
  try {
    return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort();
  } catch (error) {
    reportInvalid(directory, error);
    return null;
  }
}

export function loadHookRegistryRecords(
  directory = path.join(CONFIG_DIR, 'hooks'),
): HookRegistryRecord[] {
  const files = registryFiles(directory);
  if (!files) return [];
  const records: HookRegistryRecord[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    try {
      const filePath = path.join(directory, file);
      const entry = validateHookEntry(JSON.parse(fs.readFileSync(filePath, 'utf8')));
      if (ids.has(entry.id)) throw new Error(`duplicate hook id "${entry.id}"`);
      ids.add(entry.id);
      records.push({ entry, filePath, source: classifyHookSource(entry) });
    } catch (error) {
      reportInvalid(file, error);
    }
  }
  return records;
}

export function loadHookRegistry(
  directory = path.join(CONFIG_DIR, 'hooks'),
): HookEntry[] {
  return loadHookRegistryRecords(directory).map((record) => record.entry);
}

function registryHook(record: HookRegistryRecord): RegistryHook {
  return {
    kind: 'registry',
    id: record.entry.id,
    event: record.entry.event,
    enabled: record.entry.enabled !== false,
    source: record.source,
    entry: record.entry,
    filePath: record.filePath,
  };
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function templateHook(
  template: string,
  phase: typeof TEMPLATE_PHASES[number],
  value: unknown,
): TemplateHook | null {
  const run = optionalObject(value);
  if (!run || typeof run.command !== 'string' || run.command.trim() === '') return null;
  return {
    kind: 'template',
    id: `template:${template}:${phase.phase}`,
    event: phase.event,
    enabled: true,
    source: classifyHookSource({}, 'template'),
    run: run as unknown as TemplateRun,
    template,
    phase: phase.phase,
  };
}

function hooksFromTemplate(filePath: string): TemplateHook[] {
  const filename = path.basename(filePath, '.json');
  const value = optionalObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  if (!value) throw new Error('template must be an object');
  if (value.name !== undefined && value.name !== filename) {
    throw new Error(`name field "${String(value.name)}" does not match filename`);
  }
  const hooks = optionalObject(value.hooks);
  if (!hooks) return [];
  return TEMPLATE_PHASES
    .map((phase) => templateHook(filename, phase, hooks[phase.field]))
    .filter((hook): hook is TemplateHook => hook !== null);
}

function loadTemplateHooks(directory: string): TemplateHook[] {
  const files = registryFiles(directory);
  if (!files) return [];
  const hooks: TemplateHook[] = [];
  for (const file of files) {
    try {
      hooks.push(...hooksFromTemplate(path.join(directory, file)));
    } catch (error) {
      reportInvalid(file, error);
    }
  }
  return hooks;
}

export function loadMountedHooks(
  registryDir = path.join(CONFIG_DIR, 'hooks'),
  templateDir = path.join(CONFIG_DIR, 'thread-templates', 'templates'),
): MountedHook[] {
  const registry = loadHookRegistryRecords(registryDir).map(registryHook);
  return [...registry, ...loadTemplateHooks(templateDir)];
}

export function summarizeMountedHook(hook: MountedHook): MountedHookSummary {
  return { id: hook.id, event: hook.event, enabled: hook.enabled, source: hook.source };
}

export function loadMountedHookSummaries(
  registryDir = path.join(CONFIG_DIR, 'hooks'),
  templateDir = path.join(CONFIG_DIR, 'thread-templates', 'templates'),
): MountedHookSummary[] {
  return loadMountedHooks(registryDir, templateDir).map(summarizeMountedHook);
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

const effectiveBackends = effectiveHookBackends;

function matchesEvent(entry: HookEntry, criteria: HookFilterCriteria): boolean {
  return criteria.event === undefined || entry.event === criteria.event;
}

function matchesBackend(entry: HookEntry, criteria: HookFilterCriteria): boolean {
  return criteria.backend === undefined || effectiveBackends(entry).includes(criteria.backend);
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
