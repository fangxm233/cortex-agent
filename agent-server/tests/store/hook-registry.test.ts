// input:  hook registry API, shipped defaults, temporary JSON entries
// output: schema, loading, filtering, and managed-default tests
// pos:    Verifies the standalone declarative hook registry
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, vi } from 'vitest';

import { DEFAULTS_DIR } from '../../src/core/paths.js';
import {
  filterHookEntries,
  loadHookRegistry,
  validateHookEntry,
  type HookEntry,
} from '../../src/store/hook-registry.js';

function makeRegistry(t: { onTestFinished(callback: () => void): void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-registry-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeEntry(directory: string, filename: string, entry: unknown): void {
  fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(entry, null, 2)}\n`);
}

test('loads a valid hook entry synchronously with every schema field', (t) => {
  const directory = makeRegistry(t);
  const entry = {
    id: 'approval-hook',
    event: 'agent:pre-tool',
    matcher: 'Edit|Write',
    run: { script: 'approval.mjs', timeout: 10 },
    scope: { backends: ['claude'], requiresTool: 'Edit' },
    blocking: { mode: 'webhook', ttlMin: 30 },
    result: 'hook-result',
    enabled: true,
    version: '2026.7.29',
  };
  writeEntry(directory, 'approval.json', entry);

  assert.deepEqual(loadHookRegistry(directory), [entry]);
});

const VALID_SCHEMA_ENTRY = {
  id: 'schema-hook',
  event: 'agent:pre-tool',
  matcher: 'Edit',
  run: { command: 'true' },
};

const INVALID_SCHEMA_CASES: Array<[string, unknown, RegExp]> = [
  ['blank cc event', { ...VALID_SCHEMA_ENTRY, event: 'cc:   ' }, /unsupported hook event/],
  ['blank pi event', { ...VALID_SCHEMA_ENTRY, event: 'pi:\t' }, /unsupported hook event/],
  ['blank cortex event', { ...VALID_SCHEMA_ENTRY, event: 'cortex:   ', matcher: {} }, /unsupported hook event/],
  ['missing run target', { ...VALID_SCHEMA_ENTRY, run: {} }, /exactly one/],
  ['two run targets', { ...VALID_SCHEMA_ENTRY, run: { command: 'true', script: 'hook.mjs' } }, /exactly one/],
  ['non-positive timeout', { ...VALID_SCHEMA_ENTRY, run: { command: 'true', timeout: 0 } }, /positive number/],
  ['unsupported backend', { ...VALID_SCHEMA_ENTRY, scope: { backends: ['other'] } }, /unsupported backend/],
  ['empty required tool', { ...VALID_SCHEMA_ENTRY, scope: { requiresTool: ' ' } }, /non-empty string/],
  ['unsupported blocking mode', { ...VALID_SCHEMA_ENTRY, blocking: { mode: 'poll', ttlMin: 1 } }, /must be webhook/],
  ['non-positive blocking ttl', { ...VALID_SCHEMA_ENTRY, blocking: { mode: 'webhook', ttlMin: 0 } }, /positive number/],
  ['non-boolean enabled', { ...VALID_SCHEMA_ENTRY, enabled: 'yes' }, /must be a boolean/],
  ['invalid CalVer', { ...VALID_SCHEMA_ENTRY, version: 'latest' }, /must be a CalVer string/],
];

test.each(INVALID_SCHEMA_CASES)('rejects invalid schema: %s', (_name, entry, message) => {
  assert.throws(() => validateHookEntry(entry), message);
});

test('skips invalid entries with loud errors and continues loading', (t) => {
  const directory = makeRegistry(t);
  const valid = {
    id: 'permission-hook',
    event: 'cc:PermissionRequest',
    matcher: 'Edit|Write',
    run: { command: 'printf ok', timeout: 5 },
  };
  writeEntry(directory, '01-valid.json', valid);
  writeEntry(directory, '02-namespace.json', { ...valid, id: 'bad-namespace', event: 'other:event' });
  writeEntry(directory, '03-regex.json', { ...valid, id: 'bad-regex', matcher: '[' });
  writeEntry(directory, '04-script.json', { ...valid, id: 'bad-script', run: { script: '../escape.mjs' } });
  fs.writeFileSync(path.join(directory, '05-malformed.json'), '{bad json');
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());

  assert.deepEqual(loadHookRegistry(directory), [valid]);
  assert.equal(error.mock.calls.length, 4);
  assert.match(error.mock.calls.flat().join('\n'), /02-namespace\.json/);
  assert.match(error.mock.calls.flat().join('\n'), /05-malformed\.json/);
});

test('accepts the closed result enum and skips other result values', (t) => {
  const directory = makeRegistry(t);
  const base = { event: 'cortex:thread.end', matcher: {}, run: { command: 'true' } };
  writeEntry(directory, '01-hook-result.json', { ...base, id: 'hook-result', result: 'hook-result' });
  writeEntry(directory, '02-stdout.json', { ...base, id: 'stdout', result: 'stdout-as-prompt' });
  writeEntry(directory, '03-none.json', { ...base, id: 'none', result: 'none' });
  writeEntry(directory, '04-invalid.json', { ...base, id: 'invalid', result: { mode: 'hook-result' } });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());

  assert.deepEqual(loadHookRegistry(directory).map((entry) => entry.id), ['hook-result', 'stdout', 'none']);
  assert.match(error.mock.calls.flat().join('\n'), /result must be hook-result, stdout-as-prompt, or none/);
});

test('validates optional matcher shape by event namespace', (t) => {
  const directory = makeRegistry(t);
  const run = { command: 'true' };
  writeEntry(directory, '01-agent-all.json', { id: 'agent-all', event: 'agent:turn-end', run });
  writeEntry(directory, '02-cortex-filter.json', { id: 'cortex-filter', event: 'cortex:thread.end', matcher: { source: 'dispatch', terminal: true, count: 1, empty: null }, run });
  writeEntry(directory, '03-invalid-a.json', { id: 'agent-object', event: 'agent:turn-end', matcher: {}, run });
  writeEntry(directory, '04-invalid-b.json', { id: 'cortex-string', event: 'cortex:thread.end', matcher: '.*', run });
  writeEntry(directory, '05-invalid-c.json', { id: 'cortex-nested', event: 'cortex:thread.end', matcher: { source: { nested: true } }, run });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());

  assert.deepEqual(loadHookRegistry(directory).map((entry) => entry.id), ['agent-all', 'cortex-filter']);
  const messages = error.mock.calls.flat().join('\n');
  assert.match(messages, /agent-object.*matcher must be a string/);
  assert.match(messages, /cortex-string.*matcher must be an object/);
});

test('returns an empty registry instead of throwing when the directory is missing', (t) => {
  const directory = makeRegistry(t);
  fs.rmSync(directory, { recursive: true, force: true });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());

  assert.deepEqual(loadHookRegistry(directory), []);
  assert.equal(error.mock.calls.length, 1);
  assert.match(error.mock.calls[0]?.join(' ') ?? '', /hook-registry/);
});

test('keeps the first lexical entry when hook ids are duplicated', (t) => {
  const directory = makeRegistry(t);
  const first = { id: 'same-id', event: 'pi:tool_call', matcher: 'read', run: { command: 'first' } };
  const second = { ...first, run: { command: 'second' } };
  writeEntry(directory, '01-first.json', first);
  writeEntry(directory, '02-second.json', second);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());

  assert.deepEqual(loadHookRegistry(directory), [first]);
  assert.match(error.mock.calls.flat().join('\n'), /duplicate hook id "same-id"/);
});

function hook(id: string, event: HookEntry['event'], extra: Partial<HookEntry> = {}): HookEntry {
  return { id, event, matcher: '.*', run: { command: id }, ...extra };
}

test('filters entries by exact event while preserving source order', () => {
  const entries = [
    hook('pre-one', 'agent:pre-tool'),
    hook('post', 'agent:post-tool'),
    hook('pre-two', 'agent:pre-tool'),
  ];

  assert.deepEqual(
    filterHookEntries(entries, { event: 'agent:pre-tool' }).map((entry) => entry.id),
    ['pre-one', 'pre-two'],
  );
});

test('filters by implicit backend and explicit backend narrowing', () => {
  const entries = [
    hook('agent-both', 'agent:pre-tool'),
    hook('agent-claude', 'agent:pre-tool', { scope: { backends: ['claude'] } }),
    hook('cc-native', 'cc:PermissionRequest'),
    hook('pi-native', 'pi:tool_call'),
    hook('server', 'cortex:thread.start'),
  ];

  assert.deepEqual(
    filterHookEntries(entries, { backend: 'claude' }).map((entry) => entry.id),
    ['agent-both', 'agent-claude', 'cc-native'],
  );
  assert.deepEqual(
    filterHookEntries(entries, { backend: 'pi' }).map((entry) => entry.id),
    ['agent-both', 'pi-native'],
  );
});

test('gates requiresTool only when available tools are supplied and omits disabled entries', () => {
  const entries = [
    hook('always', 'agent:pre-tool'),
    hook('ask', 'agent:pre-tool', { scope: { requiresTool: 'AskUserQuestion' } }),
    hook('disabled', 'agent:pre-tool', { enabled: false }),
  ];

  assert.deepEqual(filterHookEntries(entries, {}).map((entry) => entry.id), ['always', 'ask']);
  assert.deepEqual(
    filterHookEntries(entries, { availableTools: new Set(['Read']) }).map((entry) => entry.id),
    ['always'],
  );
  assert.deepEqual(
    filterHookEntries(entries, { availableTools: new Set(['AskUserQuestion']) }).map((entry) => entry.id),
    ['always', 'ask'],
  );
});

const VERSION = '2026.7.29';
const INTERACTION_VERSION = '2026.7.29-1';
const DEFAULT_ENTRIES: Array<{ filename: string; entry: HookEntry }> = [
  {
    filename: '01-sensitive-file-edit.json',
    entry: { id: 'sensitive-file-edit', event: 'agent:pre-tool', matcher: 'Edit|Write', run: { script: 'sensitive-file-edit.mjs', timeout: 10 }, enabled: true, version: VERSION },
  },
  {
    filename: '02-tasks-yaml-guard.json',
    entry: { id: 'tasks-yaml-guard', event: 'agent:pre-tool', matcher: 'Edit|Write', run: { script: 'tasks-yaml-guard.mjs', timeout: 10 }, scope: { backends: ['claude'] }, enabled: true, version: VERSION },
  },
  {
    filename: '03-ask-user-question-hook.json',
    entry: { id: 'ask-user-question-hook', event: 'agent:pre-tool', matcher: 'AskUserQuestion', run: { script: 'ask-user-question-hook.mjs', timeout: 3600 }, scope: { backends: ['claude'], requiresTool: 'AskUserQuestion' }, enabled: true, version: INTERACTION_VERSION },
  },
  {
    filename: '04-exit-plan-mode-hook.json',
    entry: { id: 'exit-plan-mode-hook', event: 'agent:pre-tool', matcher: 'ExitPlanMode', run: { script: 'exit-plan-mode-hook.mjs', timeout: 3600 }, scope: { backends: ['claude'], requiresTool: 'ExitPlanMode' }, enabled: true, version: INTERACTION_VERSION },
  },
  {
    filename: '05-memory-ref-tracker.json',
    entry: { id: 'memory-ref-tracker', event: 'agent:post-tool', matcher: 'Read|Grep', run: { script: 'memory-ref-tracker.mjs' }, enabled: true, version: VERSION },
  },
  {
    filename: '06-rules-loader.json',
    entry: { id: 'rules-loader', event: 'agent:post-tool', matcher: 'Read|Grep', run: { script: 'rules-loader.mjs' }, enabled: true, version: VERSION },
  },
  {
    filename: '07-session-activity-tracker.json',
    entry: { id: 'session-activity-tracker', event: 'agent:post-tool', matcher: 'Read|Edit|Write|Skill', run: { script: 'session-activity-tracker.mjs' }, enabled: true, version: VERSION },
  },
  {
    filename: '08-cortex-md-injector-post-tool.json',
    entry: { id: 'cortex-md-injector-post-tool', event: 'agent:post-tool', matcher: 'Read|Edit', run: { script: 'cortex-md-injector.mjs' }, enabled: true, version: VERSION },
  },
  {
    filename: '09-permission-request-auto-allow.json',
    entry: { id: 'permission-request-auto-allow', event: 'cc:PermissionRequest', matcher: 'Edit|Write', run: { command: `printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`, timeout: 5 }, enabled: true, version: VERSION },
  },
  {
    filename: '10-cortex-md-injector-session-start.json',
    entry: { id: 'cortex-md-injector-session-start', event: 'agent:session-start', matcher: 'startup|resume|clear|compact', run: { script: 'cortex-md-injector.mjs' }, enabled: true, version: VERSION },
  },
  {
    filename: '11-task-status-check.json',
    entry: { id: 'task-status-check', event: 'cortex:thread.end', matcher: { source: 'task-dispatch' }, run: { script: 'task-status-check.mjs', timeout: 10 }, result: 'hook-result', enabled: true, version: VERSION },
  },
  {
    filename: '12-session-new-hook.json',
    entry: { id: 'session-new-hook', event: 'cortex:session.new', run: { script: 'new-session-hook.mjs', timeout: 60 }, result: 'stdout-as-prompt', enabled: true, version: VERSION },
  },
];

test('loads the twelve shipped hook entries in parity-preserving order', () => {
  const directory = path.join(DEFAULTS_DIR, 'config', 'hooks');
  const filenames = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort();

  assert.deepEqual(filenames, DEFAULT_ENTRIES.map(({ filename }) => filename));
  assert.deepEqual(loadHookRegistry(directory), DEFAULT_ENTRIES.map(({ entry }) => entry));
});
