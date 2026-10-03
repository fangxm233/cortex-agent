import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS_DIR } from '../../src/core/paths.js';
import { retireThreadAndTaskState, runMigrations } from '../../src/store/version-migrations.js';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';

// An install upgraded from a release that still had threads and the task queue: thread templates,
// the generated thread/task MCP configs, task settings and schedules, thread state, the task hooks,
// and a session journal that recorded a thread session.

let root: string;
let home: string;
let store: string;

const p = (...parts: string[]) => path.join(home, ...parts);
const s = (...parts: string[]) => path.join(store, ...parts);

async function write(filePath: string, content: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function archived(dir: string, prefix: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(prefix)).map((name) => path.join(dir, name));
}

const OWN_MAIN = '{"name":"main","profile":"__active__","persistSession":true,"pluginDirs":["plugins/mine"]}';
const BUNDLED = (bundles: string[]) => ({
  command: 'node', args: ['/install/dist/domain/mcp/bundled-server.js', JSON.stringify(bundles)], cwd: '/install',
});
const THREAD_SESSION = {
  name: 'cortex-a1b2c3', sessionId: 'sid-thread', projectId: 'general', channel: 'thread:thr_1', backend: 'claude',
  kind: 'local', origin: 'thread', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: '2026-09-01T00:00:00.000Z',
  label: null, profileName: null,
};

async function seedHome(): Promise<void> {
  await write(p('config', 'thread-templates', 'agents', 'main.json'), OWN_MAIN);
  await write(p('config', 'thread-templates', 'agents', 'coder.json'), { name: 'coder' });
  await write(p('config', 'thread-templates', 'templates', 'default.json'), { name: 'default' });
  await write(p('config', 'thread-templates', 'shells', 'worker-review.json'), { name: 'worker-review' });
  await write(p('config', 'thread-templates.json.migrated-bak'), { agents: {} });

  await write(p('config', 'mcp-config.json'), { mcpServers: {
    'cortex-core': BUNDLED(['cortex-core', 'cortex-tasks', 'cortex-manager-qa', 'cortex-ext']),
    'cortex-tasks': BUNDLED(['cortex-tasks']),
    mine: { command: '/opt/mine', args: ['--serve'] },
  } });
  for (const name of ['thread', 'tasks', 'manager-qa']) {
    await write(p('config', `mcp-config-${name}.json`), { mcpServers: {} });
  }
  await write(p('config', 'mcp-tool-gates', 'gate-abc.json'), { mcpServers: {
    'cortex-core': {
      ...BUNDLED(['cortex-core', 'cortex-thread']),
      env: {
        CORTEX_MCP_BUNDLES: JSON.stringify(['cortex-core', 'cortex-thread']),
        CORTEX_MCP_TOOL_ALLOWLIST: JSON.stringify(['current_time', 'task_status', 'thread_wait']),
      },
    },
  } });
  await write(p('config', 'settings.json'), {
    streamDeltas: false,
    taskDispatchEnabled: false, taskDispatchIntervalMs: 60000, taskDispatchMaxConcurrent: 2,
    taskArchiveEnabled: true, taskArchiveIntervalMs: 3600000, dispatchReconcilerEnabled: true,
    taskArtifactTemplates: ['manager'], managerRotateSteps: 8, threadMaxDepth: 3, waitingSweepMs: 1000,
  });
  await write(p('config', 'hooks', '02-tasks-yaml-guard.json'), {
    id: 'tasks-yaml-guard', event: 'agent:pre-tool', matcher: 'Edit|Write',
    run: { script: 'tasks-yaml-guard.mjs', timeout: 10 }, enabled: true,
  });
  await write(p('hooks', 'tasks-yaml-guard.mjs'), '// shipped\n');
  await write(p('hooks', 'post-task-hook.mjs'), '// shipped\n');
  await write(p('rules', 'task-system.md'), '# Task system\n');
  await write(p('rules', 'status-md.md'), '# STATUS.md\n');

  await write(s('schedules.json'), { tasks: [
    { id: 'aaaa1111', type: 'interval', dispatchType: 'task-dispatch', intervalMs: 60000 },
    { id: 'bbbb2222', type: 'daily', time: '09:00', message: 'summarize new papers' },
  ] });
  await write(s('threads.json'), { thr_1: { threadId: 'thr_1' } });
  await write(s('archive', 'threads-archive.jsonl'), '{"threadId":"thr_0"}\n');
  await write(s('production-topology', 'facts.jsonl'), '{}\n');
  await write(s('pending-tasks.json'), []);
  await write(s('task-mutation-locks', 'proj.lock'), 'lock');
  await write(s('session-registry.jsonl'), `${JSON.stringify({ v: 1, op: 'put', id: 'sid-thread', record: THREAD_SESSION })}\n`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'retire-threads-'));
  home = path.join(root, 'home');
  store = path.join(home, 'data');
  await seedHome();
});

afterEach(async () => {
  delete process.env.CORTEX_CONFIG_IMMUTABLE;
  await fs.rm(root, { recursive: true, force: true });
});

test('an upgraded home is retired in one pass and its thread session still replays', async () => {
  await runMigrations({ dataDir: home, defaultsDir: DEFAULTS_DIR, storeDir: store });

  // Environments were seeded from the install's own agent before the agents were archived.
  expect(await fs.readFile(p('config', 'environments', 'main.json'), 'utf8')).toBe(OWN_MAIN);
  expect(existsSync(p('config', 'environments', 'creative.json'))).toBe(true);

  // Config is moved aside, not deleted.
  expect(existsSync(p('config', 'thread-templates'))).toBe(false);
  const [templates] = await archived(p('config', 'archive'), 'thread-templates-');
  expect(await fs.readFile(path.join(templates, 'agents', 'main.json'), 'utf8')).toBe(OWN_MAIN);
  expect(existsSync(path.join(templates, 'shells', 'worker-review.json'))).toBe(true);
  expect(existsSync(path.join(templates, 'thread-templates.json.migrated-bak'))).toBe(true);
  const [configArchive] = await archived(p('config', 'archive'), 'retired-threads-tasks-');
  for (const name of ['thread', 'tasks', 'manager-qa']) {
    expect(existsSync(p('config', `mcp-config-${name}.json`))).toBe(false);
    expect(existsSync(path.join(configArchive, `mcp-config-${name}.json`))).toBe(true);
  }
  expect(existsSync(path.join(configArchive, 'rules', 'task-system.md'))).toBe(true);
  expect(existsSync(path.join(configArchive, 'hooks', 'post-task-hook.mjs'))).toBe(true);
  expect(existsSync(p('rules', 'task-system.md'))).toBe(false);
  expect(existsSync(p('rules', 'status-md.md'))).toBe(true);

  // The shipped task hook is retired with its script.
  expect(existsSync(p('config', 'hooks', '02-tasks-yaml-guard.json'))).toBe(false);
  expect(existsSync(p('hooks', 'tasks-yaml-guard.mjs'))).toBe(false);

  // MCP configs and gated allowlists stop naming the removed surface; user servers stay.
  const mcp = await readJson(p('config', 'mcp-config.json'));
  expect(Object.keys(mcp.mcpServers).sort()).toEqual(['cortex-core', 'mine']);
  expect(mcp.mcpServers['cortex-core'].args[1]).toBe(JSON.stringify(['cortex-core', 'cortex-ext']));
  expect(mcp.mcpServers.mine).toEqual({ command: '/opt/mine', args: ['--serve'] });
  const gate = (await readJson(p('config', 'mcp-tool-gates', 'gate-abc.json'))).mcpServers['cortex-core'];
  expect(gate.args[1]).toBe(JSON.stringify(['cortex-core']));
  expect(gate.env.CORTEX_MCP_BUNDLES).toBe(JSON.stringify(['cortex-core']));
  expect(gate.env.CORTEX_MCP_TOOL_ALLOWLIST).toBe(JSON.stringify(['current_time']));

  // Settings keep only what still exists.
  expect(await readJson(p('config', 'settings.json'))).toEqual({ streamDeltas: false });

  // The task-queue job leaves the schedule; the user's schedule stays.
  expect((await readJson(s('schedules.json'))).tasks.map((task: { id: string }) => task.id)).toEqual(['bbbb2222']);

  // Thread and task state is moved under data/archive.
  const [stateArchive] = await archived(s('archive'), 'retired-threads-tasks-');
  for (const name of ['threads.json', 'threads-archive.jsonl', 'production-topology', 'pending-tasks.json', 'task-mutation-locks']) {
    expect(existsSync(path.join(stateArchive, name)), name).toBe(true);
  }
  expect(existsSync(s('threads.json'))).toBe(false);
  expect(existsSync(s('archive', 'threads-archive.jsonl'))).toBe(false);
  expect(existsSync(path.join(stateArchive, 'production-topology', 'facts.jsonl'))).toBe(true);

  const versions = await readJson(s('versions.json'));
  expect(versions['sentinel:retire-threads-tasks']).toBe('2026.10.2');

  // A journal line written while threads existed still replays.
  const sessions = new SessionRegistryRepo(s('session-registry.jsonl'));
  expect(await sessions.getById('sid-thread')).toMatchObject({ sessionId: 'sid-thread', origin: 'thread' });

  // Once recorded, the step never runs again.
  const before = await fs.readdir(p('config', 'archive'));
  await runMigrations({ dataDir: home, defaultsDir: DEFAULTS_DIR, storeDir: store });
  expect(await fs.readdir(p('config', 'archive'))).toEqual(before);
});

test('a second pass finds nothing left to move', async () => {
  const first = new Date('2026-10-03T12:00:00.000Z');
  await retireThreadAndTaskState(home, store, DEFAULTS_DIR, first);
  await retireThreadAndTaskState(home, store, DEFAULTS_DIR, new Date('2026-10-03T12:00:05.000Z'));

  expect((await fs.readdir(p('config', 'archive'))).sort()).toEqual([
    'retired-threads-tasks-20261003T120000Z', 'thread-templates-20261003T120000Z',
  ]);
  expect(await fs.readdir(s('archive'))).toEqual(['retired-threads-tasks-20261003T120000Z']);
});

test('an archive target that already exists stops the step instead of overwriting it', async () => {
  const now = new Date('2026-10-03T12:00:00.000Z');
  await write(p('config', 'archive', 'retired-threads-tasks-20261003T120000Z', 'mcp-config-thread.json'), 'older');
  await expect(retireThreadAndTaskState(home, store, DEFAULTS_DIR, now)).rejects.toThrow(/already exists/);
  expect(await fs.readFile(
    p('config', 'archive', 'retired-threads-tasks-20261003T120000Z', 'mcp-config-thread.json'), 'utf8',
  )).toBe('older');
  expect(existsSync(p('config', 'mcp-config-thread.json'))).toBe(true);
});

test('a sealed config is left as it is while thread state is still moved aside', async () => {
  process.env.CORTEX_CONFIG_IMMUTABLE = '1';
  await retireThreadAndTaskState(home, store, DEFAULTS_DIR, new Date('2026-10-03T12:00:00.000Z'));

  expect(existsSync(p('config', 'thread-templates', 'agents', 'main.json'))).toBe(true);
  expect(existsSync(p('config', 'mcp-config-thread.json'))).toBe(true);
  expect((await readJson(p('config', 'settings.json'))).threadMaxDepth).toBe(3);
  expect(existsSync(p('config', 'archive'))).toBe(false);
  expect(existsSync(s('threads.json'))).toBe(false);
  expect(existsSync(s('archive', 'retired-threads-tasks-20261003T120000Z', 'threads.json'))).toBe(true);
});
