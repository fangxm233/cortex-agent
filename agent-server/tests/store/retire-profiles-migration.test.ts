import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { retireProfiles } from '../../src/store/retire-profiles-migration.js';
import { SessionRegistryRepo, sessionStore } from '../../src/store/session-registry-repo.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const ARCHIVE = 'config/archive/profiles-20261015T120000000Z/profiles.json';
const DEFAULT = { backend: 'claude', provider: null, model: 'opus', thinking: 'xhigh', mode: 'plan' };
const PI = { backend: 'pi', provider: 'deepseek', model: 'flash', thinking: 'xhigh', mode: 'deepseek' };
let home: string;

function write(relative: string, value: unknown): void {
  const target = path.join(home, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}

function read(relative: string): string { return fs.readFileSync(path.join(home, relative), 'utf8'); }
function json(relative: string): any { return JSON.parse(read(relative)); }
function exists(relative: string): boolean { return fs.existsSync(path.join(home, relative)); }
function migrate() { return retireProfiles({ dataDir: home, storeDir: path.join(home, 'data'), now: NOW }); }
function repo() { return new SessionRegistryRepo(path.join(home, 'data/session-registry.jsonl')); }
function put(id: string, channel: string, profileName: string | null) {
  return { v: 1, op: 'put', id, record: {
    sessionId: id, channel, profileName, backend: 'claude', kind: 'local', origin: 'direct',
    projectId: 'general', createdAt: NOW.toISOString(), lastUsedAt: NOW.toISOString(), label: null,
  } };
}
function journal(events: unknown[]): void {
  write('data/session-registry.jsonl', events.map(event => JSON.stringify(event)).join('\n') + '\n');
}
function seed(): void {
  write('config/profiles.json', { defaultProfile: 'plan', profiles: {
    plan: { ...DEFAULT, fallback: [{ model: 'discarded' }], extraEnv: { SECRET: 'never-log-this' }, maxOutputTokens: 100 },
    duplicate: { ...DEFAULT, thinking: 'high' },
    flash: { backend: 'pi', provider: 'deepseek', mode: 'deepseek', model: 'flash', extraOption: { '--thinking': 'xhigh' } },
    effort: { backend: 'claude', mode: 'api', model: 'sonnet', extraOption: { '--effort': 'high' } },
  } });
  write('data/agent-state.json', {
    activeProfile: 'flash', channelProfiles: { a: 'plan', b: 'flash', missing: 'qwen-ksu' },
    channelOverrides: { a: { model: 'opus-custom', thinking: null, mode: 'api' },
      b: { provider: 'other', model: 'other-model', mode: 'stale-route' }, orphan: { thinking: 'low' } },
    defaultAgent: 'main', channelAgents: { a: 'creative' }, unrelated: 42,
    selectionDefault: { profileName: 'flash', model: 'seed-model', agentName: 'creative' },
  });
  write('data/schedules.json', { tasks: [
    { id: 'one', profile: 'plan', prompt: 'keep' }, { id: 'two', profile: 'qwen-ksu' },
  ], unrelated: true });
  write('config/environments/main.json', { profile: 'plan', pluginDirs: ['mine'], custom: true });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-migration-test-'));
  vi.stubEnv('CORTEX_CONFIG_IMMUTABLE', '0');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

describe('S10 retire profiles', () => {
  it('maps one snapshot into defaults, deduplicated favorites, memory, channels, schedules and archive', async () => {
    seed();
    const original = read('config/profiles.json');
    const report = await migrate();
    const models = json('config/models.json');
    expect(models.default).toEqual(DEFAULT);
    expect(models.favorites).toEqual([
      { backend: 'claude', provider: null, model: 'opus' },
      { backend: 'pi', provider: 'deepseek', model: 'flash' },
      { backend: 'claude', provider: null, model: 'sonnet' },
    ]);
    const state = json('data/agent-state.json');
    expect(state.modelMemory[JSON.stringify(['pi', 'deepseek', 'flash'])]).toEqual({ thinking: 'xhigh', mode: 'deepseek' });
    expect(state.modelMemory[JSON.stringify(['claude', null, 'sonnet'])]).toEqual({ thinking: 'high', mode: 'api' });
    expect(state.modelMemory[JSON.stringify(['claude', null, 'opus'])]).toEqual({ thinking: 'xhigh', mode: 'plan' });
    expect(state.channelSelections).toEqual({
      a: { ...DEFAULT, model: 'opus-custom', thinking: null, mode: 'api' },
      b: { ...PI, provider: 'other', model: 'other-model', mode: 'other' },
      missing: DEFAULT, orphan: { ...PI, thinking: 'low' },
    });
    expect(state.selectionDefault).toEqual({ ...PI, model: 'seed-model', agentName: 'creative' });
    expect(state).toMatchObject({ defaultAgent: 'main', channelAgents: { a: 'creative' }, unrelated: 42 });
    for (const key of ['activeProfile', 'channelProfiles', 'channelOverrides']) expect(state).not.toHaveProperty(key);
    expect(json('data/schedules.json')).toEqual({ tasks: [
      { id: 'one', selection: DEFAULT, prompt: 'keep' }, { id: 'two', selection: DEFAULT },
    ], unrelated: true });
    expect(json('config/environments/main.json')).toEqual({ pluginDirs: ['mine'], custom: true });
    expect(read(ARCHIVE)).toBe(original);
    expect(exists('config/profiles.json')).toBe(false);
    expect(report).toMatchObject({ profiles: 4, favorites: 3, channels: 4, overrides: 3, schedules: 2, environments: 1 });
    expect(report.missingNames).toEqual(expect.arrayContaining([
      { name: 'qwen-ksu', context: 'channel:missing' }, { name: 'qwen-ksu', context: 'schedule:two' },
    ]));
    expect(report.discarded).toContainEqual({ name: 'plan', fields: ['fallback', 'extraEnv', 'maxOutputTokens'] });
    expect(JSON.stringify(report)).not.toContain('never-log-this');
  });

  it('captures raw put/patch/unset names before the new reader drops them, then appends through a local repo', async () => {
    seed();
    journal([
      put('changed', 'a', 'flash'), { v: 1, op: 'patch', id: 'changed', fields: { profileName: 'plan' } },
      put('unset', 'plain', 'flash'), { v: 1, op: 'patch', id: 'unset', fields: {}, unset: ['profileName'] },
      put('deleted', 'a', 'plan'),
      { ...put('deleted', 'a', 'plan'), op: 'delete-intent', cleanup: { claudeBackupPaths: [] } },
      { v: 1, op: 'delete-commit', id: 'deleted' },
      put('pi', 'b', 'flash'),
      { v: 1, op: 'conversation', channel: 'a', kind: 'set', fields: {
        sessionId: 'changed', backend: 'claude', profileName: 'plan', updatedAt: NOW.toISOString(),
      } },
      { v: 1, op: 'conversation', channel: 'standalone', kind: 'set', fields: {
        sessionId: null, backend: 'pi', profileName: 'flash', updatedAt: NOW.toISOString(),
      } },
    ]);
    const before = read('data/session-registry.jsonl');
    const globalWrite = vi.spyOn(sessionStore, 'updateSession').mockRejectedValue(new Error('global repo forbidden'));
    const report = await migrate();
    expect(globalWrite).not.toHaveBeenCalled();
    expect(read('data/session-registry.jsonl').startsWith(before)).toBe(true);
    expect((await repo().getById('changed'))?.selection).toEqual({ ...DEFAULT, model: 'opus-custom', thinking: null, mode: 'api' });
    expect((await repo().getById('pi'))?.selection).toEqual({ ...PI, provider: 'other', model: 'other-model', mode: 'other' });
    expect(await repo().getById('deleted')).toBeNull();
    expect((await repo().getById('unset'))?.selection).toBeNull();
    expect((await repo().getConversationHeader('a'))?.selection).toEqual((await repo().getById('changed'))?.selection);
    expect((await repo().getConversationHeader('standalone'))?.selection).toEqual(PI);
    expect(report).toMatchObject({ sessions: 2, conversations: 2 });
  });

  it('resumes a failed append without losing overrides or duplicating earlier patches', async () => {
    seed();
    journal([put('first', 'a', 'plan'), put('second', 'b', 'flash')]);
    const original = SessionRegistryRepo.prototype.updateSession;
    let calls = 0;
    const append = vi.spyOn(SessionRegistryRepo.prototype, 'updateSession').mockImplementation(async function(id, fields) {
      if (++calls === 2) throw new Error('simulated disk failure');
      return original.call(this, id, fields);
    });
    await expect(migrate()).rejects.toThrow('simulated disk failure');
    expect(exists('config/profiles.json')).toBe(true);
    expect(json('data/agent-state.json').channelOverrides).toBeDefined();
    append.mockRestore();
    await migrate();
    const patches = read('data/session-registry.jsonl').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.op === 'patch');
    expect(patches).toHaveLength(2);
    expect((await repo().getById('second'))?.selection).toEqual({ ...PI, provider: 'other', model: 'other-model', mode: 'other' });
    const after = read('data/session-registry.jsonl');
    await migrate();
    expect(read('data/session-registry.jsonl')).toBe(after);
    expect(fs.readdirSync(path.join(home, 'config/archive'))).toHaveLength(1);
  });

  it('retries after state was committed and preserves already materialized selections and model memory', async () => {
    seed();
    const preserved = { ...PI, model: 'chosen-after-migration' };
    write('config/models.json', { default: preserved, favorites: [] });
    write('data/agent-state.json', { channelSelections: { a: preserved }, selectionDefault: preserved,
      modelMemory: { [JSON.stringify(['pi', 'deepseek', 'flash'])]: { thinking: 'low', mode: 'deepseek' } } });
    write('data/schedules.json', { tasks: [{ id: 'one', selection: preserved, profile: 'plan' }] });
    journal([{ ...put('already', 'a', 'plan'), record: { ...put('already', 'a', 'plan').record, selection: preserved } }]);
    await migrate();
    expect(json('config/models.json').default).toEqual(preserved);
    expect(json('data/agent-state.json').channelSelections.a).toEqual(preserved);
    expect(json('data/agent-state.json').selectionDefault).toEqual(preserved);
    expect(json('data/agent-state.json').modelMemory[JSON.stringify(['pi', 'deepseek', 'flash'])].thinking).toBe('low');
    expect(json('data/schedules.json').tasks[0]).toEqual({ id: 'one', selection: preserved });
    expect((await repo().getById('already'))?.selection).toEqual(preserved);
  });

  it('retries after the final archive fails without losing merged session overrides', async () => {
    seed();
    journal([put('one', 'a', 'plan')]);
    write(ARCHIVE, 'an older archive must not be overwritten');
    await expect(migrate()).rejects.toThrow('Archive target already exists');
    expect(read(ARCHIVE)).toBe('an older archive must not be overwritten');
    expect(exists('config/profiles.json')).toBe(true);
    expect(json('data/agent-state.json')).not.toHaveProperty('channelOverrides');
    const beforeRetry = read('data/session-registry.jsonl');
    await retireProfiles({ dataDir: home, storeDir: path.join(home, 'data'), now: new Date(NOW.getTime() + 1) });
    expect(read('data/session-registry.jsonl')).toBe(beforeRetry);
    expect((await repo().getById('one'))?.selection).toEqual({ ...DEFAULT, model: 'opus-custom', thinking: null, mode: 'api' });
    expect(exists('config/profiles.json')).toBe(false);
  });

  it('ignores an uncommitted tail but refuses malformed committed journal lines', async () => {
    seed();
    journal([put('one', 'a', 'plan')]);
    const committed = read('data/session-registry.jsonl');
    write('data/session-registry.jsonl', committed + '{bad committed line}\n');
    await expect(migrate()).rejects.toThrow();
    expect(exists('config/profiles.json')).toBe(true);
    expect(json('data/agent-state.json').channelOverrides).toBeDefined();
    write('data/session-registry.jsonl', committed + '{"v":1,"op":"patch","id":"one","fields":{"profileName":"flash"}}');
    await migrate();
    expect((await repo().getById('one'))?.selection).toEqual({ ...DEFAULT, model: 'opus-custom', thinking: null, mode: 'api' });
  });

  it('leaves non-engine schedules intact and does not archive after malformed state', async () => {
    seed();
    const jobs = { tasks: [{ id: 'script', dispatchType: 'script', command: 'keep' }] };
    write('data/schedules.json', jobs);
    write('data/agent-state.json', '{ broken');
    await expect(migrate()).rejects.toThrow();
    expect(exists('config/models.json')).toBe(false);
    expect(exists('config/profiles.json')).toBe(true);
    write('data/agent-state.json', {});
    const report = await migrate();
    expect(report.schedules).toBe(0);
    expect(json('data/schedules.json')).toEqual(jobs);
  });

  it('honors immutable homes before any config, state or registry write', async () => {
    seed();
    journal([put('one', 'a', 'plan')]);
    const files = ['config/profiles.json', 'data/agent-state.json', 'data/schedules.json', 'data/session-registry.jsonl', 'config/environments/main.json'];
    const before = files.map(read);
    vi.stubEnv('CORTEX_CONFIG_IMMUTABLE', '1');
    expect(await migrate()).toMatchObject({ skipped: 'immutable' });
    expect(files.map(read)).toEqual(before);
    expect(exists('config/models.json')).toBe(false);
    expect(exists('config/archive')).toBe(false);
  });

  it('does nothing for a fresh home and refuses malformed sources instead of retiring them', async () => {
    expect(await migrate()).toMatchObject({ skipped: 'no-profiles' });
    expect(fs.readdirSync(home)).toEqual([]);
    write('config/profiles.json', '{ broken');
    await expect(migrate()).rejects.toThrow();
    expect(read('config/profiles.json')).toBe('{ broken');
    expect(exists('config/models.json')).toBe(false);
  });
});
