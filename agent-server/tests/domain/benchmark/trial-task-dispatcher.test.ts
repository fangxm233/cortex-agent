// input:  P9 implementation, host task-lock / gpu / rate-limit modules (contrast only)
// output: behavioral proof of the in-trial dispatcher + the composite-runtime-ports wire
// pos:    Gate-5 port P9 — the in-trial dispatch path and its host-coupling absence
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isProjectLocked } from '../../../src/domain/tasks/system/task-lock.js';
import { PROJECTS_DIR } from '../../../src/core/paths.js';
import { filterDispatchableTasks } from '../../../src/domain/tasks/dispatcher.js';
import { _testSetRegistry } from '../../../src/domain/tasks/dispatch-utils.js';
import { loadConfig } from '../../../src/domain/threads/template-loader.js';
import { profileRepo, PROFILES_FILE } from '../../../src/store/profile-repo.js';
import * as throttle from '../../../src/domain/costs/rate-limit-throttle.js';
import { MockAdapter } from '../../../src/platform/testing.js';
import {
  createTrialTaskDispatcher, filterTrialDispatchable,
  type TrialTaskDispatcherDeps, type TrialThreadTemplate,
} from '../../../src/domain/benchmark/trial-task-dispatcher.js';
import { createDispatcherPort } from '../../../src/domain/benchmark/composite-runtime-ports.js';
import { createTrialClock } from '../../../src/domain/benchmark/trial-clock.js';
import type { Task } from '../../../src/core/task-parser.js';

// --- fixtures ----------------------------------------------------------------

const WHITELIST = ['benchmark-coder-review', 'benchmark-coder-review-fix'];

function makeTask(overrides: Partial<Task> & { id: string; project: string; text: string }): Task {
  return {
    why: '',
    done_when: '',
    priority: 'medium',
    status: 'open',
    template: 'benchmark-coder-review',
    plan: '',
    parent: null,
    depends_on: [],
    gpu: null,
    gpu_count: 0,
    blocked_by: null,
    claimed_by: null,
    claimed_at: null,
    dispatch_generation: null,
    paused: false,
    approval_needed: false,
    approved_at: null,
    not_before: null,
    completed_at: null,
    completed_note: null,
    pending_at: null,
    origin_session_id: null,
    origin_channel: null,
    origin_thread_id: null,
    ...overrides,
  };
}

function makeTemplate(name: string): TrialThreadTemplate {
  return {
    name,
    description: `template ${name}`,
    agents: [],
    transitions: [],
    entryAgent: 'coder',
    maxTotalSteps: 100,
  };
}

interface Fixture {
  deps: TrialTaskDispatcherDeps;
  claims: { taskId: string; generation: string }[];
  setTasks(tasks: Task[]): void;
  addTemplate(name: string, template: TrialThreadTemplate): void;
}

function fixture(overrides: Partial<TrialTaskDispatcherDeps> = {}): Fixture {
  let tasks: Task[] = [];
  const templates = new Map<string, TrialThreadTemplate>();
  const claims: { taskId: string; generation: string }[] = [];
  const deps: TrialTaskDispatcherDeps = {
    getActionable: () => tasks,
    getTemplate: (name) => templates.get(name) ?? null,
    childTemplateWhitelist: [...WHITELIST],
    claim: (taskId, generation) => {
      claims.push({ taskId, generation });
      return { success: true };
    },
    pollIntervalMs: 1,
    sleep: async () => {},
    ...overrides,
  };
  return {
    deps,
    claims,
    setTasks: (next) => { tasks = next; },
    addTemplate: (name, template) => { templates.set(name, template); },
  };
}

function installOutageProfile(): void {
  fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify({
    defaultProfile: 'outage-profile',
    profiles: {
      'outage-profile': {
        model: 'test-model', backend: 'pi', provider: 'provider-a', mode: 'api',
      },
    },
  }));
  profileRepo.invalidate();
}

// --- P9 eligibility: what the in-trial path does instead of the three host filters ------------

describe('filterTrialDispatchable (P9 eligibility)', () => {
  const tpl = makeTemplate('benchmark-coder-review');

  it('drops tasks with no template and keeps templated ones', () => {
    const tasks = [
      makeTask({ id: 'a1', project: 'trial', text: 'no template', template: '' }),
      makeTask({ id: 'b2', project: 'trial', text: 'templated' }),
    ];
    const eligible = filterTrialDispatchable(tasks, WHITELIST, () => tpl);
    expect(eligible.map(task => task.id)).toEqual(['b2']);
  });

  it('drops templates outside the frozen child-template whitelist (R6)', () => {
    const tasks = [
      makeTask({ id: 'a1', project: 'trial', text: 'outside whitelist', template: 'doc-review' }),
      makeTask({ id: 'b2', project: 'trial', text: 'whitelisted' }),
    ];
    const eligible = filterTrialDispatchable(tasks, WHITELIST, () => tpl);
    expect(eligible.map(task => task.id)).toEqual(['b2']);
  });

  it('drops whitelisted names the frozen resolver cannot resolve', () => {
    const tasks = [makeTask({ id: 'a1', project: 'trial', text: 'unresolvable' })];
    const eligible = filterTrialDispatchable(tasks, WHITELIST, () => null);
    expect(eligible).toEqual([]);
  });
});

// --- selectAndClaim ---------------------------------------------------------------------------

describe('AwaitableTaskDispatcher.selectAndClaim (§7.2 P9)', () => {
  it('returns null when no task is actionable', () => {
    const { deps } = fixture();
    expect(createTrialTaskDispatcher(deps).selectAndClaim({ trial: 'trial-1' })).toBeNull();
  });

  it.each([null, '', ' \t', 'null', 'undefined'])(
    'rejects the shipped invalid-prompt case %j without claiming it',
    (text) => {
      const f = fixture();
      f.addTemplate('benchmark-coder-review', makeTemplate('benchmark-coder-review'));
      f.setTasks([makeTask({
        id: 'a1', project: 'trial', text: text as unknown as string,
      })]);

      expect(createTrialTaskDispatcher(f.deps).selectAndClaim({ trial: 'trial-1' })).toBeNull();
      expect(f.claims).toEqual([]);
    },
  );

  it('selects the first eligible task and returns prompt, template and generation', () => {
    const f = fixture();
    const selected = makeTask({ id: 'b2', project: 'trial', text: 'the task' });
    f.setTasks([
      makeTask({ id: 'a1', project: 'trial', text: 'no template', template: '' }),
      selected,
    ]);
    f.addTemplate('benchmark-coder-review', makeTemplate('benchmark-coder-review'));

    const selection = createTrialTaskDispatcher(f.deps).selectAndClaim({ trial: 'trial-1' });

    expect(selection).not.toBeNull();
    expect(selection!.task.id).toBe('b2');
    expect(selection!.template.name).toBe('benchmark-coder-review');
    expect(selection!.prompt).toContain('**Task:** the task');
    expect(selection!.prompt).toContain('**Task ID:** b2');
    expect(selection!.dispatchGeneration).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(f.claims).toHaveLength(1);
    expect(f.claims[0].taskId).toBe('b2');
    expect(f.claims[0].generation).toBe(selection!.dispatchGeneration);
  });

  it('mints a fresh generation per claim — two claims never share a generation', () => {
    const f = fixture();
    f.addTemplate('benchmark-coder-review', makeTemplate('benchmark-coder-review'));
    const dispatcher = createTrialTaskDispatcher(f.deps);

    f.setTasks([makeTask({ id: 'a1', project: 'trial', text: 'first' })]);
    const first = dispatcher.selectAndClaim({ trial: 'trial-1' });
    f.setTasks([makeTask({ id: 'b2', project: 'trial', text: 'second' })]);
    const second = dispatcher.selectAndClaim({ trial: 'trial-1' });

    expect(first!.dispatchGeneration).not.toBe(second!.dispatchGeneration);
    expect(first!.dispatchGeneration).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second!.dispatchGeneration).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('returns null when the claim is refused — the claim is still attempted', () => {
    const attempted: { taskId: string; generation: string }[] = [];
    const f = fixture({
      claim: (taskId, generation) => {
        attempted.push({ taskId, generation });
        return { success: false, message: 'stale' };
      },
    });
    f.setTasks([makeTask({ id: 'a1', project: 'trial', text: 'task' })]);
    f.addTemplate('benchmark-coder-review', makeTemplate('benchmark-coder-review'));

    const selection = createTrialTaskDispatcher(f.deps).selectAndClaim({ trial: 'trial-1' });

    expect(selection).toBeNull();
    expect(attempted).toHaveLength(1);
    expect(attempted[0].taskId).toBe('a1');
  });

  it('does not consult the host lock table — a project the host has locked still dispatches', () => {
    const lockedProject = `_test_trial_dispatch_lock_${process.pid}`;
    fs.mkdirSync(path.join(PROJECTS_DIR, lockedProject), { recursive: true });
    fs.writeFileSync(path.join(PROJECTS_DIR, lockedProject, 'TASKS.yaml'), [
      'lock:',
      "  owner: some-agent",
      "  acquired_at: '2026-01-01T00:00:00.000Z'",
      "  expires_at: '2099-01-01T00:00:00.000Z'",
      'tasks: []',
      '',
    ].join('\n'));
    try {
      // the host would block this project today…
      expect(isProjectLocked(lockedProject).locked).toBe(true);

      const f = fixture();
      f.addTemplate('benchmark-coder-review', makeTemplate('benchmark-coder-review'));
      f.setTasks([makeTask({ id: 'a1', project: lockedProject, text: 'locked on host' })]);

      const selection = createTrialTaskDispatcher(f.deps).selectAndClaim({ trial: 'trial-1' });
      expect(selection).not.toBeNull();
      expect(selection!.task.id).toBe('a1');
    } finally {
      try { fs.unlinkSync(path.join(PROJECTS_DIR, lockedProject, 'TASKS.yaml')); } catch {}
      try { fs.rmdirSync(path.join(PROJECTS_DIR, lockedProject)); } catch {}
    }
  });

  it('does not consult host GPU state — a gpu-tagged task the host filter would drop still dispatches', async () => {
    loadConfig();
    _testSetRegistry({ testbox: { cortexPath: '/tmp/test', gpuCount: 2 } });
    try {
      const hostBlocked = await filterDispatchableTasks([
        makeTask({ id: 'a1', project: 'trial', text: 'gpu task', gpu: 'testbox', gpu_count: 1, template: 'default' }),
      ], 'sched-1', new Map(), {
        findActiveDispatchMatch: () => null,
        checkRealGpuOccupancy: async () => ({
          gpus: [{ index: 0, occupied: true, processes: [{ pid: '123', name: 'python', memoryMB: 4096 }] }],
          freeIndices: [], allOccupied: true,
        }),
      });
      expect(hostBlocked).toEqual([]); // host GPU preflight drops it

      const f = fixture({ childTemplateWhitelist: ['default'] });
      f.addTemplate('default', makeTemplate('default'));
      f.setTasks([makeTask({ id: 'a1', project: 'trial', text: 'gpu task', gpu: 'testbox', gpu_count: 1, template: 'default' })]);

      const selection = createTrialTaskDispatcher(f.deps).selectAndClaim({ trial: 'trial-1' });
      expect(selection).not.toBeNull();
      expect(selection!.task.id).toBe('a1');
    } finally {
      _testSetRegistry({});
    }
  });

  it('does not consult host template rate limits — a host-rate-limited template still dispatches', async () => {
    installOutageProfile();
    loadConfig();
    await throttle.initRateLimitThrottle(new MockAdapter({ adminChannel: 'admin' }), {
      save: async () => {},
      load: async () => null,
    });
    try {
      await throttle.activateOutageWindow('provider-a', 5 * 60_000);
      const hostBlocked = await filterDispatchableTasks([
        makeTask({ id: 'a1', project: 'trial', text: 'provider work', template: 'default' }),
      ], 'dispatch-schedule', new Map(), {
        findActiveDispatchMatch: () => null,
        checkRealGpuOccupancy: async () => ({ gpus: [], freeIndices: [], allOccupied: false }),
        profileName: 'outage-profile',
      });
      expect(hostBlocked).toEqual([]); // host rate-limit preflight drops it

      const f = fixture({ childTemplateWhitelist: ['default'] });
      f.addTemplate('default', makeTemplate('default'));
      f.setTasks([makeTask({ id: 'a1', project: 'trial', text: 'provider work', template: 'default' })]);

      const selection = createTrialTaskDispatcher(f.deps).selectAndClaim({ trial: 'trial-1' });
      expect(selection).not.toBeNull();
      expect(selection!.task.id).toBe('a1');
    } finally {
      throttle._testReset();
    }
  });
});

// --- awaitNextDispatchable --------------------------------------------------------------------

describe('AwaitableTaskDispatcher.awaitNextDispatchable (§7.2 P9)', () => {
  it('returns a selection as soon as one becomes dispatchable, polling at the injected interval', async () => {
    let tasks: Task[] = [];
    let sleepCalls = 0;
    const f = fixture({
      getActionable: () => tasks,
      pollIntervalMs: 25,
      sleep: async (ms) => {
        sleepCalls += 1;
        expect(ms).toBe(25);
        tasks = [makeTask({ id: 'b2', project: 'trial', text: 'arrives later' })];
      },
    });
    f.addTemplate('benchmark-coder-review', makeTemplate('benchmark-coder-review'));

    const selection = await createTrialTaskDispatcher(f.deps)
      .awaitNextDispatchable(new AbortController().signal);

    expect(selection).not.toBeNull();
    expect(selection!.task.id).toBe('b2');
    expect(sleepCalls).toBeGreaterThanOrEqual(1);
  });

  it('resolves null when the signal aborts, even with dispatchable candidates pending', async () => {
    const { deps } = fixture();
    const controller = new AbortController();
    controller.abort(new Error('deadline'));
    await expect(
      createTrialTaskDispatcher(deps).awaitNextDispatchable(controller.signal),
    ).resolves.toBeNull();
  });

  it('stops polling once the signal aborts mid-wait', async () => {
    let sleepCalls = 0;
    const controller = new AbortController();
    const { deps } = fixture({
      sleep: async () => {
        sleepCalls += 1;
        controller.abort();
      },
    });

    const selection = await createTrialTaskDispatcher(deps)
      .awaitNextDispatchable(controller.signal);

    expect(selection).toBeNull();
    expect(sleepCalls).toBe(1);
  });

  it('resolves null when the real deterministic-clock sleep rejects on abort', async () => {
    const controller = new AbortController();
    const clock = createTrialClock({ deadlineEpochMs: Date.now() + 60_000 });
    const { deps } = fixture({ pollIntervalMs: 60_000, sleep: clock.sleep });

    const pending = createTrialTaskDispatcher(deps).awaitNextDispatchable(controller.signal);
    controller.abort(new Error('deadline'));

    await expect(pending).resolves.toBeNull();
  });

  it('propagates sleep failures that are not caused by abort', async () => {
    const failure = new Error('clock failed');
    const { deps } = fixture({ sleep: async () => { throw failure; } });

    await expect(
      createTrialTaskDispatcher(deps).awaitNextDispatchable(new AbortController().signal),
    ).rejects.toBe(failure);
  });
});

// --- the composite-runtime-ports wire ----------------------------------------------------------

describe('createDispatcherPort — P9 wired into CompositeRuntimePorts (§7.2)', () => {
  it('returns an AwaitableTaskDispatcher usable through the frozen interface', () => {
    const f = fixture();
    f.addTemplate('benchmark-coder-review', makeTemplate('benchmark-coder-review'));
    f.setTasks([makeTask({ id: 'a1', project: 'trial', text: 'wired' })]);

    const port = createDispatcherPort(f.deps);
    const selection = port.selectAndClaim({ trial: 'trial-1' });

    expect(selection).not.toBeNull();
    expect(selection!.task.id).toBe('a1');
    expect(port.buildDispatchPrompt(selection!.task)).toBe(selection!.prompt);
  });
});
