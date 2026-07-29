// input:  Vitest, temp JSON, provider-state domains
// output: Provider persistence and guarded migration regressions
// pos:    Store coverage for provider-state.json ownership
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { afterAll, afterEach, beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ProviderStateRepo,
} from '../../src/store/provider-state-repo.js';
import { runMigrations } from '../../src/store/version-migrations.js';
import {
  getThrottleState,
  initRateLimitThrottle,
  _testReset as resetThrottle,
  type RateLimitThrottleState,
} from '../../src/domain/costs/rate-limit-throttle.js';
import {
  getResumeCount,
  initResumeRegistry,
  _testReset as resetResumes,
  type ResumeEntry,
} from '../../src/domain/costs/resume-registry.js';

let tmpDir: string;
let testIndex = 0;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-provider-state-test-'));
});

afterEach(() => {
  resetThrottle();
  resetResumes();
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function nextDir(): string {
  return path.join(tmpDir, String(testIndex++));
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
}

function activeThrottle(): RateLimitThrottleState {
  return {
    providers: [{
      provider: 'provider-a',
      displayName: 'Provider A',
      modes: ['plan'],
      windows: [{
        type: 'outage',
        utilization: null,
        resetsAt: Math.floor(Date.now() / 1000) + 3_600,
        activatedAt: Date.now(),
      }],
    }],
  };
}

function resumeEntries(): ResumeEntry[] {
  return [{
    kind: 'thread',
    provider: 'provider-a',
    threadId: 'thread-a',
    channel: 'channel-a',
    userMessage: 'continue',
    recordedAt: 100,
  }];
}

test('ProviderStateRepo defaults to no throttle and an empty resume queue', async () => {
  const repo = new ProviderStateRepo(path.join(nextDir(), 'provider-state.json'));

  assert.equal(await repo.getRateLimitThrottle(), null);
  assert.deepEqual(await repo.getResumeQueue(), []);
});

test('ProviderStateRepo serializes concurrent throttle and resume writes', async () => {
  const filePath = path.join(nextDir(), 'provider-state.json');
  const repo = new ProviderStateRepo(filePath);
  const throttle = activeThrottle();
  const resumes = resumeEntries();

  await Promise.all([
    repo.setRateLimitThrottle(throttle),
    repo.setResumeQueue(resumes),
  ]);

  assert.deepEqual(await repo.getRateLimitThrottle(), throttle);
  assert.deepEqual(await repo.getResumeQueue(), resumes);
  assert.deepEqual(await readJson(filePath), {
    rateLimitThrottle: throttle,
    resumeQueue: resumes,
  });
});

test('provider throttle persistence leaves schedules.json content and mtime unchanged', async () => {
  const dir = nextDir();
  const schedulesFile = path.join(dir, 'schedules.json');
  const providerStateFile = path.join(dir, 'provider-state.json');
  await writeJson(schedulesFile, { tasks: [{ id: 'schedule-a' }] });
  const beforeContent = await fs.readFile(schedulesFile, 'utf8');
  const beforeMtime = (await fs.stat(schedulesFile)).mtimeMs;

  await new ProviderStateRepo(providerStateFile).setRateLimitThrottle(activeThrottle());

  assert.equal(await fs.readFile(schedulesFile, 'utf8'), beforeContent);
  assert.equal((await fs.stat(schedulesFile)).mtimeMs, beforeMtime);
});

test('active windows and resume entries hydrate from a fresh repository instance', async () => {
  const filePath = path.join(nextDir(), 'provider-state.json');
  const first = new ProviderStateRepo(filePath);
  await first.setRateLimitThrottle(activeThrottle());
  await first.setResumeQueue(resumeEntries());
  await first.flush();

  const restarted = new ProviderStateRepo(filePath);
  await initResumeRegistry({
    save: (entries) => restarted.setResumeQueue(entries),
    load: () => restarted.getResumeQueue(),
  });
  await initRateLimitThrottle({} as Parameters<typeof initRateLimitThrottle>[0], {
    save: (state) => restarted.setRateLimitThrottle(state),
    load: () => restarted.getRateLimitThrottle(),
  });

  assert.equal(getResumeCount(), 1);
  assert.equal(getThrottleState().isThrottled, true);
  assert.deepEqual(getThrottleState().providers.map((entry) => entry.provider), ['provider-a']);
});

test('runMigrations moves legacy provider state and strips schedules idempotently', async () => {
  const dataDir = nextDir();
  const storeDir = path.join(dataDir, 'data');
  const schedulesFile = path.join(storeDir, 'schedules.json');
  const providerStateFile = path.join(storeDir, 'provider-state.json');
  const defaultsDir = path.join(dataDir, 'defaults');
  const throttle = activeThrottle();
  const resumes = resumeEntries();
  const schedules = {
    tasks: [{ id: 'schedule-a', message: 'run' }],
    rateLimitThrottle: throttle,
    resumeQueue: resumes,
  };
  await writeJson(schedulesFile, schedules);

  await runMigrations({ dataDir, storeDir, defaultsDir });

  assert.deepEqual(await readJson(providerStateFile), {
    rateLimitThrottle: throttle,
    resumeQueue: resumes,
  });
  assert.deepEqual(await readJson(schedulesFile), { tasks: schedules.tasks });
  const firstProvider = await fs.readFile(providerStateFile, 'utf8');
  const firstSchedules = await fs.readFile(schedulesFile, 'utf8');

  await runMigrations({ dataDir, storeDir, defaultsDir });

  assert.equal(await fs.readFile(providerStateFile, 'utf8'), firstProvider);
  assert.equal(await fs.readFile(schedulesFile, 'utf8'), firstSchedules);
});

test('runMigrations prefers existing provider state while stripping legacy fields', async () => {
  const dataDir = nextDir();
  const storeDir = path.join(dataDir, 'data');
  const schedulesFile = path.join(storeDir, 'schedules.json');
  const providerStateFile = path.join(storeDir, 'provider-state.json');
  const defaultsDir = path.join(dataDir, 'defaults');
  const existing = {
    rateLimitThrottle: null,
    resumeQueue: [{
      kind: 'direct',
      provider: 'provider-b',
      channel: 'channel-b',
      userMessage: 'resume',
      recordedAt: 200,
    }],
  };
  await writeJson(providerStateFile, existing);
  const originalProvider = await fs.readFile(providerStateFile, 'utf8');
  await writeJson(schedulesFile, {
    tasks: [{ id: 'schedule-b' }],
    rateLimitThrottle: activeThrottle(),
    resumeQueue: resumeEntries(),
  });

  await runMigrations({ dataDir, storeDir, defaultsDir });

  assert.equal(await fs.readFile(providerStateFile, 'utf8'), originalProvider);
  assert.deepEqual(await readJson(schedulesFile), { tasks: [{ id: 'schedule-b' }] });
});

test('runMigrations preserves legacy fields when existing provider state is malformed', async () => {
  const dataDir = nextDir();
  const storeDir = path.join(dataDir, 'data');
  const schedulesFile = path.join(storeDir, 'schedules.json');
  const providerStateFile = path.join(storeDir, 'provider-state.json');
  const defaultsDir = path.join(dataDir, 'defaults');
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(providerStateFile, '{"rateLimitThrottle":');
  await writeJson(schedulesFile, {
    tasks: [{ id: 'schedule-c' }],
    rateLimitThrottle: activeThrottle(),
    resumeQueue: resumeEntries(),
  });
  const originalProvider = await fs.readFile(providerStateFile, 'utf8');
  const originalSchedules = await fs.readFile(schedulesFile, 'utf8');
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    await runMigrations({ dataDir, storeDir, defaultsDir });

    assert.equal(await fs.readFile(providerStateFile, 'utf8'), originalProvider);
    assert.equal(await fs.readFile(schedulesFile, 'utf8'), originalSchedules);
    assert.ok(warnSpy.mock.calls.some((call) =>
      call.some((value) => String(value).includes('Could not migrate legacy provider state'))));
  } finally {
    warnSpy.mockRestore();
  }
});
