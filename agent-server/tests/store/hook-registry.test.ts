import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, vi } from 'vitest';

import {
  filterHookEntries,
  loadHookRegistry,
  loadHookRegistryRecords,
  loadMountedHookSummaries,
  BUILTIN_HOOK_REGISTRY_DIR,
  validateHookEntry,
  type HookEntry,
  type HookRegistryDirs,
} from '../../src/store/hook-registry.js';

/** The user registry alone, without the shipped layer. */
function only(user: string): HookRegistryDirs {
  return { user, builtin: null };
}

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
    result: 'none',
    enabled: true,
    version: '2026.7.29',
  };
  writeEntry(directory, 'approval.json', entry);

  assert.deepEqual(loadHookRegistry(only(directory)), [entry]);
});

test('a shipped entry loads in place and a user file of the same name is merged over it', (t) => {
  const root = makeRegistry(t);
  const builtin = path.join(root, 'shipped');
  const user = path.join(root, 'user');
  fs.mkdirSync(builtin);
  fs.mkdirSync(user);
  const shipped = { ...VALID_SCHEMA_ENTRY, id: 'shipped', enabled: true };
  writeEntry(builtin, '01-shipped.json', shipped);
  writeEntry(builtin, '02-other.json', { ...VALID_SCHEMA_ENTRY, id: 'other' });
  writeEntry(user, '50-mine.json', { ...VALID_SCHEMA_ENTRY, id: 'mine' });

  const plain = loadHookRegistryRecords({ user, builtin });
  assert.deepEqual(plain.map((record) => [record.entry.id, record.source]), [
    ['shipped', 'builtin'], ['other', 'builtin'], ['mine', 'user'],
  ]);
  assert.equal(plain[0].filePath, path.join(builtin, '01-shipped.json'));
  assert.equal(plain[0].builtin?.override, null);

  writeEntry(user, '01-shipped.json', { enabled: false, id: 'renamed' });
  const [overridden] = loadHookRegistryRecords({ user, builtin });
  assert.deepEqual(overridden.entry, { ...shipped, enabled: false });
  assert.equal(overridden.filePath, path.join(user, '01-shipped.json'));
  assert.deepEqual(overridden.builtin?.entry, shipped);

  assert.deepEqual(loadMountedHookSummaries({ user, builtin }), [
    { id: 'shipped', event: 'agent:pre-tool', enabled: false, source: 'builtin', overridden: true },
    { id: 'other', event: 'agent:pre-tool', enabled: true, source: 'builtin', overridden: false },
    { id: 'mine', event: 'agent:pre-tool', enabled: true, source: 'user', overridden: false },
  ]);
  assert.deepEqual(loadHookRegistry({ user, builtin: null }).map((entry) => entry.id), ['mine']);
});

test('an unreadable override is reported and the shipped entry stays mounted', (t) => {
  const root = makeRegistry(t);
  const builtin = path.join(root, 'shipped');
  const user = path.join(root, 'user');
  fs.mkdirSync(builtin);
  fs.mkdirSync(user);
  writeEntry(builtin, '01-shipped.json', { ...VALID_SCHEMA_ENTRY, id: 'shipped' });
  fs.writeFileSync(path.join(user, '01-shipped.json'), '{bad json');
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());

  assert.deepEqual(loadHookRegistry({ user, builtin }).map((entry) => entry.id), ['shipped']);
  assert.match(error.mock.calls.flat().join('\n'), /01-shipped\.json/);
});

test('the shipped registrations load from an empty home', () => {
  const ids = loadHookRegistry({ user: path.join(os.tmpdir(), 'no-such-hooks-dir'), builtin: BUILTIN_HOOK_REGISTRY_DIR })
    .map((entry) => entry.id);
  assert.ok(ids.includes('rules-loader'));
  assert.ok(ids.includes('status-md-guard'));
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

  assert.deepEqual(loadHookRegistry(only(directory)), [valid]);
  assert.equal(error.mock.calls.length, 4);
  assert.match(error.mock.calls.flat().join('\n'), /02-namespace\.json/);
  assert.match(error.mock.calls.flat().join('\n'), /05-malformed\.json/);
});

const RESULT_CAPABILITY_CASES: Array<[string, HookEntry['event'], HookEntry['result']]> = [
  ['thread start HookResult', 'cortex:thread.start', 'hook-result'],
  ['thread transition HookResult', 'cortex:thread.transition', 'hook-result'],
  ['thread end HookResult', 'cortex:thread.end', 'hook-result'],
  ['new-session prompt', 'cortex:session.new', 'stdout-as-prompt'],
  ['message-end prompt', 'cortex:session.messageEnd', 'stdout-as-prompt'],
  ['explicit fire-and-forget on a result-capable event', 'cortex:thread.end', 'none'],
  ['explicit fire-and-forget elsewhere', 'cortex:dispatch.started', 'none'],
];

test.each(RESULT_CAPABILITY_CASES)('accepts result capability: %s', (_name, event, result) => {
  assert.equal(validateHookEntry({
    id: 'capability-hook',
    event,
    matcher: {},
    run: { command: 'true' },
    result,
  }).result, result);
});

const INVALID_RESULT_CAPABILITY_CASES: Array<[string, HookEntry['event'], HookEntry['result']]> = [
  ['HookResult on an agent event', 'agent:pre-tool', 'hook-result'],
  ['HookResult on a session event', 'cortex:session.new', 'hook-result'],
  ['HookResult on an unconsumed server event', 'cortex:dispatch.started', 'hook-result'],
  ['prompt output on a thread event', 'cortex:thread.end', 'stdout-as-prompt'],
  ['prompt output on an unconsumed server event', 'cortex:task.completed', 'stdout-as-prompt'],
];

test.each(INVALID_RESULT_CAPABILITY_CASES)('rejects result capability: %s', (_name, event, result) => {
  assert.throws(() => validateHookEntry({
    id: 'invalid-capability',
    event,
    matcher: event.startsWith('cortex:') ? {} : '.*',
    run: { command: 'true' },
    result,
  }), new RegExp(`result mode "${result}" is not permitted for event "${event}"`));
});

test('skips invalid result combinations with loud errors and keeps valid combinations', (t) => {
  const directory = makeRegistry(t);
  const run = { command: 'true' };
  writeEntry(directory, '01-thread.json', { id: 'thread', event: 'cortex:thread.end', matcher: {}, run, result: 'hook-result' });
  writeEntry(directory, '02-session.json', { id: 'session', event: 'cortex:session.new', run, result: 'stdout-as-prompt' });
  writeEntry(directory, '03-none.json', { id: 'none', event: 'cortex:dispatch.started', run, result: 'none' });
  writeEntry(directory, '04-invalid-thread.json', { id: 'invalid-thread', event: 'cortex:thread.end', matcher: {}, run, result: 'stdout-as-prompt' });
  writeEntry(directory, '05-invalid-session.json', { id: 'invalid-session', event: 'cortex:session.new', run, result: 'hook-result' });
  writeEntry(directory, '06-invalid-enum.json', { id: 'invalid-enum', event: 'cortex:thread.end', matcher: {}, run, result: { mode: 'hook-result' } });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());

  assert.deepEqual(loadHookRegistry(only(directory)).map((entry) => entry.id), ['thread', 'session', 'none']);
  assert.equal(error.mock.calls.length, 3);
  const messages = error.mock.calls.flat().join('\n');
  assert.match(messages, /04-invalid-thread\.json.*stdout-as-prompt.*cortex:thread\.end/);
  assert.match(messages, /05-invalid-session\.json.*hook-result.*cortex:session\.new/);
  assert.match(messages, /06-invalid-enum\.json.*result must be hook-result, stdout-as-prompt, or none/);
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

  assert.deepEqual(loadHookRegistry(only(directory)).map((entry) => entry.id), ['agent-all', 'cortex-filter']);
  const messages = error.mock.calls.flat().join('\n');
  assert.match(messages, /agent-object.*matcher must be a string/);
  assert.match(messages, /cortex-string.*matcher must be an object/);
});

test('returns an empty registry instead of throwing when the directory is missing', (t) => {
  const directory = makeRegistry(t);
  fs.rmSync(directory, { recursive: true, force: true });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());

  assert.deepEqual(loadHookRegistry(only(directory)), []);
  assert.equal(error.mock.calls.length, 0, 'an absent user registry is the normal case');
});

test('keeps the first lexical entry when hook ids are duplicated', (t) => {
  const directory = makeRegistry(t);
  const first = { id: 'same-id', event: 'pi:tool_call', matcher: 'read', run: { command: 'first' } };
  const second = { ...first, run: { command: 'second' } };
  writeEntry(directory, '01-first.json', first);
  writeEntry(directory, '02-second.json', second);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.onTestFinished(() => error.mockRestore());

  assert.deepEqual(loadHookRegistry(only(directory)), [first]);
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
