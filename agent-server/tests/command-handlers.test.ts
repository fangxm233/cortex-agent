import { test, beforeAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { registerCommands as createCommandDispatcher } from '../src/orchestration/routing/commands/index.js';
import { CommandActionRouter } from '../src/orchestration/interactions/command-action-router.js';
import { handleBackendCmd, handleModelCmd, handleThinkingCmd } from '../src/orchestration/routing/commands/mode.js';
import { handleBudgetCmd } from '../src/orchestration/routing/commands/cost.js';
import type { ProviderUsage } from '../src/domain/costs/usage-store.js';
import type { UsageResetResult } from '../src/domain/costs/account-reset.js';
import type { ResetProvider } from '../src/domain/costs/reset-account.js';
import { usageResetNoticeActions } from '../src/orchestration/routing/commands/usage-reset.js';
import { projectStore } from '../src/domain/projects/index.js';
import {
  clearChannelSelection, getSelectionDefault, setChannelSelection,
} from '../src/domain/agents/config.js';
import { resolveRunSelection } from '../src/domain/runs/config-resolver.js';
import { getDefaultSelection } from '../src/domain/agents/models.js';
import { costRepo } from '../src/store/cost-repo.js';
import { MockAdapter } from '../src/platform/testing.js';
import { CONFIG_DIR, PROJECTS_DIR } from '../src/core/paths.js';
import { modelsRepo } from '../src/store/models-repo.js';
import { _testSetRegistry } from '../src/domain/remote/machine-registry.js';
import { runRegistry } from '../src/core/run-registry.js';
import * as executionRegistry from '../src/domain/executions/registry.js';
import { conduitQueues } from '../src/orchestration/conduit-queue.js';

const defaultSelection = { backend: 'claude' as const, provider: null, model: 'claude-sonnet-4-6', thinking: null, mode: 'plan' };
const piFavorite = { backend: 'pi' as const, provider: 'anthropic', model: 'claude-sonnet-4-6' };
function seedModels(favorites = [defaultSelection, piFavorite]) {
  fs.writeFileSync(path.join(CONFIG_DIR, 'models.json'), JSON.stringify({ default: defaultSelection, favorites }));
  modelsRepo.invalidate();
}
beforeAll(() => {
  _testSetRegistry({ testbox: { cortexPath: '/tmp/test', gpuCount: 2 } });
  seedModels();
});

const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;

function withFakeIntervals(t) {
  const intervals = [];
  let nextId = 1;
  global.setInterval = (((fn, _ms) => {
    const entry = { id: nextId++, fn };
    intervals.push(entry);
    return entry;
  }) as unknown) as typeof setInterval;
  global.clearInterval = ((handle) => {
    const idx = intervals.findIndex(entry => entry === handle || entry.id === handle);
    if (idx >= 0) intervals.splice(idx, 1);
  }) as typeof clearInterval;
  t.onTestFinished(() => {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });
  return intervals;
}

function withMockedGpuExec(t, outputsByCommand) {
  const originalEnv = process.env.CORTEX_GPU_MONITOR_MOCK;
  process.env.CORTEX_GPU_MONITOR_MOCK = JSON.stringify(outputsByCommand);
  t.onTestFinished(() => {
    if (originalEnv === undefined) delete process.env.CORTEX_GPU_MONITOR_MOCK;
    else process.env.CORTEX_GPU_MONITOR_MOCK = originalEnv;
  });
}
function withTempCostData(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cost-'));
  const costFile = path.join(dir, 'costs.json');
  const budgetFile = path.join(dir, 'budget.json');
  fs.writeFileSync(costFile, entries.map((e: any) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(budgetFile, JSON.stringify({ daily_usd: 10, monthly_usd: 100 }, null, 2));
  process.env.CORTEX_COSTS_FILE = costFile;
  process.env.CORTEX_BUDGET_FILE = budgetFile;
  // Reset the lazy JsonRepository so it picks up the new CORTEX_COSTS_FILE/CORTEX_BUDGET_FILE paths.
  costRepo._testReset();
  t.onTestFinished(() => {
    delete process.env.CORTEX_COSTS_FILE;
    delete process.env.CORTEX_BUDGET_FILE;
    costRepo._testReset();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}


test('!backend moves only this channel to the first favorite on that backend', async (t) => {
  t.onTestFinished(() => clearChannelSelection('C-backend'));
  await handleBackendCmd('C-backend', new MockAdapter(), '!backend pi');
  assert.equal(resolveRunSelection({ channel: 'C-backend' }).backend, 'pi');
  assert.equal(resolveRunSelection({ channel: 'C-other' }).backend, 'claude');
});

test('!backend refuses a backend with no favorite', async (t) => {
  t.onTestFinished(() => { clearChannelSelection('C-empty'); seedModels(); });
  seedModels([defaultSelection]);
  const adapter = new MockAdapter();
  await handleBackendCmd('C-empty', adapter, '!backend pi');
  assert.match(adapter.posted[0].content.text, /favorite|收藏/i);
  assert.equal(resolveRunSelection({ channel: 'C-empty' }).backend, 'claude');
});

test('!model sets, reports and resets a channel selection', async (t) => {
  t.onTestFinished(() => clearChannelSelection('C-model'));
  const adapter = new MockAdapter();
  await handleModelCmd('C-model', adapter, '!model haiku-test');
  assert.equal(resolveRunSelection({ channel: 'C-model' }).model, 'haiku-test');
  assert.deepEqual(getDefaultSelection(), defaultSelection);
  assert.equal(resolveRunSelection({ channel: 'C-elsewhere' }).model, defaultSelection.model);
  await handleModelCmd('C-model', adapter, '!model');
  assert.match(adapter.posted.at(-1).content.text, /haiku-test/);
  await handleModelCmd('C-model', adapter, '!model reset');
  assert.deepEqual(resolveRunSelection({ channel: 'C-model' }), defaultSelection);
});

test('!thinking sets, reports and clears only the channel level', async (t) => {
  t.onTestFinished(() => clearChannelSelection('C-think'));
  const adapter = new MockAdapter();
  await handleThinkingCmd('C-think', adapter, '!thinking');
  assert.match(adapter.posted[0].content.text, /default|默认/);
  await handleThinkingCmd('C-think', adapter, '!thinking xhigh');
  assert.equal(resolveRunSelection({ channel: 'C-think' }).thinking, 'xhigh');
  assert.equal(resolveRunSelection({ channel: 'C-elsewhere' }).thinking, null);
  await handleThinkingCmd('C-think', adapter, '!thinking reset');
  assert.equal(resolveRunSelection({ channel: 'C-think' }).thinking, null);
});

test('!thinking rejects an invalid backend level without changing selection', async (t) => {
  t.onTestFinished(() => clearChannelSelection('C-think-bad'));
  const adapter = new MockAdapter();
  await handleThinkingCmd('C-think-bad', adapter, '!thinking off');
  assert.equal(resolveRunSelection({ channel: 'C-think-bad' }).thinking, null);
  await handleThinkingCmd('C-think-bad', adapter, '!thinking ludicrous');
  assert.match(adapter.posted.at(-1).content.text, /xhigh/);
  assert.equal(resolveRunSelection({ channel: 'C-think-bad' }).thinking, null);
});

test('!thinking leaves a model chosen separately alone', async (t) => {
  t.onTestFinished(() => clearChannelSelection('C-think-model'));
  setChannelSelection('C-think-model', { ...defaultSelection, model: 'haiku-test' });
  await handleThinkingCmd('C-think-model', new MockAdapter(), '!thinking high');
  assert.equal(resolveRunSelection({ channel: 'C-think-model' }).model, 'haiku-test');
  assert.equal(resolveRunSelection({ channel: 'C-think-model' }).thinking, 'high');
  await handleThinkingCmd('C-think-model', new MockAdapter(), '!thinking reset');
  assert.equal(resolveRunSelection({ channel: 'C-think-model' }).model, 'haiku-test');
});

test('chat engine commands do not alter the new Web conversation seed', async (t) => {
  t.onTestFinished(() => clearChannelSelection('web:cmd-seed'));
  const before = getSelectionDefault();
  await handleModelCmd('web:cmd-seed', new MockAdapter(), '!model haiku-test');
  await handleThinkingCmd('web:cmd-seed', new MockAdapter(), '!thinking high');
  assert.equal(resolveRunSelection({ channel: 'web:cmd-seed' }).thinking, 'high');
  assert.deepEqual(getSelectionDefault(), before);
});

test('!cost <project> filters report to the requested project scope', async (t) => {
  const now = new Date().toISOString();
  withTempCostData(t, [
    { timestamp: now, project: 'proj-a', trigger: 'user', cost_usd: 1.5, mode: 'api' },
    { timestamp: now, project: 'proj-b', trigger: 'dispatch', cost_usd: 2.0, mode: 'plan' },
  ]);

  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
  });

  const handled = dispatchCommand('!cost proj-a', 'C123', adapter);
  assert.equal(handled, true);
  // formatCostReport is async (costRepo.readCosts reads JSONL file); wait with timeout.
  const deadline = Date.now() + 5_000;
  while (adapter.posted.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(adapter.posted.length, 1);
  assert.match(adapter.posted[0].content.text, /Cost Report \(project: proj-a\)/);
  assert.match(adapter.posted[0].content.text, /Today: \$1\.50/);
  assert.doesNotMatch(adapter.posted[0].content.text, /proj-b/);
});

const COMMAND_USAGE: ProviderUsage[] = [{
  provider: 'anthropic',
  displayName: 'Anthropic',
  modes: ['plan'],
  windows: [
    { type: 'five_hour', utilization: 0.34, resetsAt: 1_800_000_000 },
    { type: 'seven_day', utilization: 0.61, resetsAt: null },
    { type: 'model_scoped', label: 'Fable', utilization: 0.12, resetsAt: null },
  ],
  observedAt: 1_799_999_000,
  freshness: 'live',
  billing: 'subscription',
}, {
  provider: 'openai-codex',
  displayName: 'OpenAI Codex',
  modes: ['openai-codex'],
  windows: [
    { type: 'codex_primary', utilization: 0.2, resetsAt: null },
    { type: 'codex_secondary', utilization: null, resetsAt: null },
  ],
  observedAt: 1_799_998_000,
  freshness: 'stale',
  billing: 'subscription',
  note: 'push-only observation is stale',
}, {
  provider: 'deepseek',
  displayName: 'DeepSeek',
  modes: ['deepseek'],
  windows: [],
  spend: { today: 1.25, month: 4.5 },
  observedAt: null,
  freshness: 'unsupported',
  billing: 'api',
  note: 'gateway usage collection failed (month: timeout)',
}, {
  // A provider the formatter has never heard of: the report is built from whatever
  // collection observed, so an unknown id must render like any other.
  provider: 'moonshot-ai',
  displayName: 'Moonshot Ai',
  modes: ['moonshot-ai'],
  windows: [],
  spend: { today: 0, month: 2.75 },
  observedAt: null,
  freshness: 'unsupported',
  billing: 'api',
}];

test('!usage uses exact and trailing-space prefix routes with provider filtering', async () => {
  const adapter = new MockAdapter();
  let statusCalls = 0;
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    usageService: {
      getStatus: async () => { statusCalls += 1; return COMMAND_USAGE; },
      refresh: async () => COMMAND_USAGE,
    },
  });

  assert.equal(dispatchCommand('!usage', 'C-usage', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(adapter.posted[0].content.text, /Anthropic/);
  assert.match(adapter.posted[0].content.text, /DeepSeek/);

  assert.equal(dispatchCommand('!usage openai-codex', 'C-usage', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(adapter.posted[1].content.text, /OpenAI Codex/);
  assert.doesNotMatch(adapter.posted[1].content.text, /Anthropic/);

  assert.equal(dispatchCommand('!usage-extra', 'C-usage', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(adapter.posted[2].content.text, /Unknown command/);
  assert.equal(statusCalls, 2);
});

test('!usage refresh action forces every collection and preserves provider filter', async () => {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  let statusCalls = 0;
  let refreshCalls = 0;
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    commandRouter: router,
    usageService: {
      getStatus: async () => { statusCalls += 1; return COMMAND_USAGE; },
      refresh: async () => { refreshCalls += 1; return COMMAND_USAGE; },
    },
  });
  router.bindToAdapter(adapter);

  dispatchCommand('!usage openai-codex', 'C-usage', adapter);
  await new Promise(resolve => setImmediate(resolve));
  const actions = adapter.posted[0].content.richBlocks?.find(block => block.type === 'actions');
  assert.equal(actions?.elements[0].actionId, 'cmd:usage:refresh');
  assert.equal(actions?.elements[0].value, 'openai-codex');
  assert.equal(statusCalls, 1);
  assert.equal(refreshCalls, 0, 'reading usage must not collect');

  const action = { channelId: 'C-usage', messageRef: { conduit: 'C-usage', messageId: 'usage-msg-1' } };
  await adapter.simulateAction('cmd:usage:refresh', 'openai-codex', action);
  await adapter.simulateAction('cmd:usage:refresh', 'openai-codex', action);

  assert.equal(refreshCalls, 2, 'each action must force an unthrottled refresh');
  assert.equal(adapter.updated.length, 2);
  assert.match(adapter.updated[1].content.text, /OpenAI Codex.*stale/);
  assert.doesNotMatch(adapter.updated[1].content.text, /Anthropic/);
  assert.match(adapter.updated[1].content.text, /push-only observation is stale/);
});

const CODEX_WITH_RESETS: ProviderUsage = {
  ...COMMAND_USAGE[1],
  resetCredits: {
    availableCount: 1,
    credits: [{ id: 'credit-1', title: 'Full reset', expiresAt: 1_800_500_000 }],
  },
};

const CLAUDE_WITH_RESETS: ProviderUsage = {
  ...COMMAND_USAGE[0],
  resetCredits: {
    availableCount: 1,
    atLimit: false,
    credits: [{
      id: 'grant_1', title: 'Reset', expiresAt: 1_800_400_000,
      clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
    }],
  },
};

type Redeemer = (provider: ResetProvider, creditId?: string) => Promise<UsageResetResult>;

function usageDispatcher(records: ProviderUsage[], usageReset: Redeemer) {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    commandRouter: router,
    usageService: { getStatus: async () => records, refresh: async () => records },
    usageReset,
  });
  router.bindToAdapter(adapter);
  return { adapter, dispatchCommand };
}

const notReached: Redeemer = async () => { throw new Error('not reached'); };

function actionButtons(content: { richBlocks?: { type: string; elements?: { actionId: string; value?: string }[] }[] }) {
  return content.richBlocks?.find(block => block.type === 'actions')?.elements?.map(element => `${element.actionId}=${element.value}`);
}

test('!usage shows banked resets and offers a reset button per provider only while one exists', async () => {
  const withResets = usageDispatcher([CLAUDE_WITH_RESETS, CODEX_WITH_RESETS], notReached);
  withResets.dispatchCommand('!usage', 'C-usage', withResets.adapter);
  await new Promise(resolve => setImmediate(resolve));
  const post = withResets.adapter.posted[0].content;
  assert.match(post.text, /Banked resets: 1 · earliest expires 2027-01-21T/);
  assert.match(post.text, /Banked resets: 1 · earliest expires 2027-01-19T/);
  assert.deepEqual(actionButtons(post), [
    'cmd:usage:refresh=', 'cmd:usage:reset=openai-codex', 'cmd:usage:reset=anthropic',
  ]);

  withResets.dispatchCommand('!usage anthropic', 'C-usage', withResets.adapter);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actionButtons(withResets.adapter.posted[1].content), ['cmd:usage:refresh=anthropic', 'cmd:usage:reset=anthropic']);

  const spent = { ...CODEX_WITH_RESETS, resetCredits: { availableCount: 0, credits: [] } };
  const none = usageDispatcher([spent], notReached);
  none.dispatchCommand('!usage', 'C-usage', none.adapter);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(none.adapter.posted[0].content.text, /Banked resets: 0/);
  assert.deepEqual(actionButtons(none.adapter.posted[0].content), ['cmd:usage:refresh=']);
});

test('!usage reset takes a confirm click and reports the outcome in place of the prompt', async () => {
  const calls: unknown[][] = [];
  const after: ProviderUsage = { ...CODEX_WITH_RESETS, freshness: 'live', windows: [{ type: 'codex_primary', utilization: 0, resetsAt: null }] };
  const { adapter } = usageDispatcher([CODEX_WITH_RESETS], async (...args) => {
    calls.push(args);
    return { provider: 'openai-codex', status: 'reset', cleared: [], usage: [after] };
  });
  const usageMessage = { conduit: 'C-usage', messageId: 'usage-msg-1' };

  await adapter.simulateAction('cmd:usage:reset', 'openai-codex', { channelId: 'C-usage', messageRef: usageMessage });

  assert.deepEqual(calls, [], 'the first click only asks');
  const prompt = adapter.posted[0];
  assert.equal(prompt.threadId, 'usage-msg-1');
  assert.match(prompt.content.text, /Codex usage for this account on every device and cannot be undone/);
  assert.deepEqual(prompt.actions?.map(action => `${action.actionId}=${action.value}`), [
    'cmd:usage:reset-confirm=openai-codex', 'cmd:usage:reset-cancel=openai-codex',
  ]);

  const promptRef = { conduit: 'C-usage', messageId: 'prompt-1' };
  await adapter.simulateAction('cmd:usage:reset-confirm', 'openai-codex', { channelId: 'C-usage', messageRef: promptRef });

  assert.deepEqual(calls, [['openai-codex']]);
  assert.equal(adapter.updated.length, 2);
  assert.match(adapter.updated[0].content.text, /Using a Codex reset/);
  assert.match(adapter.updated[1].content.text, /Codex reset used[\s\S]*OpenAI Codex/);
  assert.ok(adapter.updated.every(update => !update.content.richBlocks?.some(block => block.type === 'actions')));
});

test('the Claude confirm names the account-wide scope, the cleared windows and the current use', async () => {
  const { adapter } = usageDispatcher([CLAUDE_WITH_RESETS], notReached);

  await adapter.simulateAction('cmd:usage:reset', 'anthropic', {
    channelId: 'C-usage', messageRef: { conduit: 'C-usage', messageId: 'usage-msg-1' },
  });

  const text = adapter.posted[0].content.text;
  assert.match(text, /clears the 5 hour, 7 day, 7 day \(incl\. overage\) limits for the whole account/);
  assert.match(text, /claude\.ai and every other device included — and cannot be undone/);
  assert.match(text, /not at a limit right now: 5 hour 34% · 7 day 61%/);

  const atLimit = { ...CLAUDE_WITH_RESETS, resetCredits: { ...CLAUDE_WITH_RESETS.resetCredits!, atLimit: true } };
  const limited = usageDispatcher([atLimit], notReached);
  await limited.adapter.simulateAction('cmd:usage:reset', 'anthropic', { channelId: 'C-usage' });
  assert.doesNotMatch(limited.adapter.posted[0].content.text, /not at a limit/);
});

test('!usage reset cancel and non-reset outcomes spend nothing extra and say why', async () => {
  let redeemed = 0;
  const { adapter } = usageDispatcher([CLAUDE_WITH_RESETS], async (provider) => {
    redeemed += 1;
    return { provider, status: redeemed === 1 ? 'nothing_to_reset' : 'cooldown', cleared: [], usage: [CLAUDE_WITH_RESETS] };
  });
  const promptRef = { conduit: 'C-usage', messageId: 'prompt-1' };

  await adapter.simulateAction('cmd:usage:reset-cancel', 'anthropic', { channelId: 'C-usage', messageRef: promptRef });
  assert.equal(redeemed, 0);
  assert.match(adapter.updated[0].content.text, /Reset not used/);

  await adapter.simulateAction('cmd:usage:reset-confirm', 'anthropic', { channelId: 'C-usage', messageRef: promptRef });
  assert.equal(redeemed, 1);
  assert.match(adapter.updated.at(-1)!.content.text, /Nothing to reset — Claude usage is not limited/);

  await adapter.simulateAction('cmd:usage:reset-confirm', 'anthropic', { channelId: 'C-usage', messageRef: promptRef });
  assert.match(adapter.updated.at(-1)!.content.text, /Claude resets are cooling down/);

  await adapter.simulateAction('cmd:usage:reset-confirm', 'deepseek', { channelId: 'C-usage', messageRef: promptRef });
  assert.equal(redeemed, 2, 'a provider without resets is never redeemed');
});

test('a throttle notice offers a reset only when the throttled account holds one', async () => {
  const status = (records: ProviderUsage[]) => ({ getStatus: async () => records });
  const ids = async (provider: string, records: ProviderUsage[]) => (
    (await usageResetNoticeActions(provider, status(records))).map(action => `${action.actionId}=${action.value}`)
  );
  assert.deepEqual(await ids('openai-codex', [CODEX_WITH_RESETS]), ['cmd:usage:reset=openai-codex']);
  assert.deepEqual(await ids('anthropic', [CLAUDE_WITH_RESETS]), ['cmd:usage:reset=anthropic']);
  assert.deepEqual(await ids('openai-codex', [COMMAND_USAGE[1]]), []);
  assert.deepEqual(await ids('anthropic', [CODEX_WITH_RESETS]), []);
  assert.deepEqual(await ids('deepseek', [CODEX_WITH_RESETS, CLAUDE_WITH_RESETS]), []);
});

// ── !budget: global + per-project forms ────────────────────────────
// Overrides are pair-only and project ids are validated against the real project registry,
// so a typo can never create an orphan entry in budget.json.

function withProjects(t, ids: string[]) {
  for (const id of ids) fs.mkdirSync(path.join(PROJECTS_DIR, id), { recursive: true });
  projectStore.refresh();
  t.onTestFinished(() => {
    for (const id of ids) fs.rmSync(path.join(PROJECTS_DIR, id), { recursive: true, force: true });
    projectStore.refresh();
  });
}

async function budget(adapter: MockAdapter, message: string): Promise<string> {
  await handleBudgetCmd('C-budget', adapter, message);
  return adapter.posted[adapter.posted.length - 1].content.text;
}

test('!budget <project> $X/d $Y/m writes a pair-only override and reports it back', async (t) => {
  withTempCostData(t, [{ timestamp: new Date().toISOString(), project: 'proj-a', trigger: 'user', cost_usd: 1.5, mode: 'api' }]);
  withProjects(t, ['proj-a']);
  const adapter = new MockAdapter();

  assert.match(await budget(adapter, '!budget proj-a $5/d $80/m'), /proj-a.*updated.*\$5\/day.*\$80\/month/);

  const persisted = await costRepo.readBudget();
  assert.deepEqual(persisted.projects['proj-a'], { daily_usd: 5, monthly_usd: 80 });
  assert.equal(persisted.daily_usd, 10, 'globals untouched');

  const status = await budget(adapter, '!budget proj-a');
  assert.match(status, /per-project override/);
  assert.match(status, /Daily: \$5/);
});

test('!budget <project> rejects a single limit without writing anything', async (t) => {
  withTempCostData(t, []);
  withProjects(t, ['proj-a']);
  const text = await budget(new MockAdapter(), '!budget proj-a $5/d');
  assert.match(text, /both limits/);
  assert.deepEqual((await costRepo.readBudget()).projects, {});
});

test('!budget rejects an unknown project and names the known ones', async (t) => {
  withTempCostData(t, []);
  withProjects(t, ['proj-a']);
  const text = await budget(new MockAdapter(), '!budget proj-typo $5/d $80/m');
  assert.match(text, /Unknown project/);
  assert.match(text, /proj-a/);
  assert.deepEqual((await costRepo.readBudget()).projects, {});
});

test('!budget <project> clear removes the override so it inherits again', async (t) => {
  withTempCostData(t, []);
  withProjects(t, ['proj-a']);
  const adapter = new MockAdapter();
  await budget(adapter, '!budget proj-a $5/d $80/m');

  assert.match(await budget(adapter, '!budget proj-a clear'), /removed/);
  assert.deepEqual((await costRepo.readBudget()).projects, {});
  assert.match(await budget(adapter, '!budget proj-a clear'), /no per-project budget/i);
});

test('!budget $X/d $Y/m still edits the globals and preserves overrides', async (t) => {
  withTempCostData(t, []);
  withProjects(t, ['proj-a']);
  const adapter = new MockAdapter();
  await budget(adapter, '!budget proj-a $5/d $80/m');

  assert.match(await budget(adapter, '!budget $50/d $1000/m'), /\$50\/day, \$1000\/month/);
  const persisted = await costRepo.readBudget();
  assert.equal(persisted.daily_usd, 50);
  assert.equal(persisted.monthly_usd, 1000);
  assert.deepEqual(persisted.projects['proj-a'], { daily_usd: 5, monthly_usd: 80 });
});

test('!schedule add leaves the default to schedule creation', async () => {
  const adapter = new MockAdapter();
  const added = [];
  const scheduler = {
    async add(spec) {
      added.push(spec);
      return {
        id: 'abcd1234',
        type: spec.type,
        intervalMs: spec.intervalMs,
        message: spec.message,
        projectId: spec.projectId,
        selection: spec.selection ?? getDefaultSelection(),
        nextRun: Date.now() + spec.intervalMs,
        createdAt: Date.now(),
      };
    },
    async pause() { return null; },
    async resume() { return null; },
    async remove() { return false; },
    async list() { return []; },
  };
  const dispatchCommand = createCommandDispatcher({
    scheduler,
  });

  assert.equal(dispatchCommand('!schedule add interval 30m test scheduled task', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(added.length, 1);
  assert.equal(added[0].type, 'interval');
  assert.equal(added[0].intervalMs, 1_800_000);
  assert.equal(added[0].message, 'test scheduled task');
  assert.equal(added[0].selection, undefined);
  assert.match(adapter.posted[0].content.text, /claude-sonnet-4-6/);
});

test('!schedule add resolves model and thinking', async () => {
  const adapter = new MockAdapter();
  const added = [];
  const scheduler = {
    async add(spec) {
      added.push(spec);
      return {
        id: 'abcd1234',
        type: spec.type,
        intervalMs: spec.intervalMs,
        message: spec.message,
        projectId: spec.projectId,
        selection: spec.selection ?? getDefaultSelection(),
        nextRun: Date.now() + spec.intervalMs,
        createdAt: Date.now(),
      };
    },
    async pause() { return null; },
    async resume() { return null; },
    async remove() { return false; },
    async list() { return []; },
  };
  const dispatchCommand = createCommandDispatcher({
    scheduler,
  });

  assert.equal(dispatchCommand('!schedule add interval 30m --model openai/gpt-test --thinking high test scheduled task', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(added.length, 1);
  assert.equal(added[0].selection.model, 'gpt-test');
  assert.equal(added[0].selection.thinking, 'high');
  assert.equal(added[0].message, 'test scheduled task');
  assert.match(adapter.posted[0].content.text, /gpt-test/);
});

test('!schedule pause/resume/remove accepts backtick-wrapped 8-char hex schedule ids', async () => {
  const adapter = new MockAdapter();
  const pausedIds = [];
  const resumedIds = [];
  const removedIds = [];
  const task = (id: string, extra: object) => ({ id, type: 'interval' as const, intervalMs: 3600000, message: 'interval task', projectId: 'general', selection: null, createdAt: 1, ...extra });
  const scheduler = {
    async pause(id) {
      pausedIds.push(id);
      return task(id, { isPaused: true, pausedAt: Date.now(), nextRun: null });
    },
    async resume(id) {
      resumedIds.push(id);
      return task(id, { isPaused: false, pausedAt: null, nextRun: Date.now() + 3600000 });
    },
    async remove(id) {
      removedIds.push(id);
      return true;
    },
    async add(): Promise<never> { throw new Error('not used'); },
    async list() { return []; },
  };
  const dispatchCommand = createCommandDispatcher({
    scheduler,
  });

  assert.equal(dispatchCommand('!schedule pause `c8d34e12`', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pausedIds, ['c8d34e12']);
  assert.match(adapter.posted[0].content.text, /Paused task `c8d34e12`/);

  assert.equal(dispatchCommand('!schedule resume `c8d34e12`', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(resumedIds, ['c8d34e12']);
  assert.match(adapter.posted[1].content.text, /Resumed task `c8d34e12`/);

  assert.equal(dispatchCommand('!schedule remove `c8d34e12`', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removedIds, ['c8d34e12']);
  assert.match(adapter.posted[2].content.text, /Removed task `c8d34e12`/);
});

// existing tests

test('!cancel <executionId> cancels that execution, and says so when nothing matches', async (t) => {
  const adapter = new MockAdapter();
  let killed = false;
  runRegistry.register({ channel: 'C1', executionId: 'exec-by-id', kill: () => { killed = true; return true; }, backend: 'test' });
  t.onTestFinished(() => { runRegistry.remove('exec-by-id'); });

  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  assert.equal(dispatchCommand('!cancel exec-by-id', 'C1', adapter), true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(killed, true);
  assert.match(adapter.posted[0].content.text, /exec-by-id.*cancelled/i);

  assert.equal(dispatchCommand('!cancel exec-missing', 'C1', adapter), true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.match(adapter.posted[1].content.text, /No running execution `exec-missing`/);
});

test('plain !cancel still cancels the current active process', async (t) => {
  const adapter = new MockAdapter();
  let killed = false;
  runRegistry.register({ channel: 'C123', executionId: 'exec-conv1', kill: () => { killed = true; return true; }, backend: 'test' });
  // Simulate a running queue entry so cancel can clear it
  conduitQueues.set('C123', Promise.resolve());
  t.onTestFinished(() => { runRegistry.remove('exec-conv1'); conduitQueues.delete('C123'); });
  const dispatchCommand = createCommandDispatcher({ scheduler: null });

  const handled = dispatchCommand('!cancel', 'C123', adapter);
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(killed, true);
  assert.equal(conduitQueues.has('C123'), false);
  assert.equal((adapter.posted[0].destination as { conduit: string }).conduit, 'C123');
});

test('!cancel marks the execution record cancelled (not failed), idempotently', async (t) => {
  const adapter = new MockAdapter();
  const rec = executionRegistry.startLocalExecution({ channel: 'Ccancel', project: 'general', trigger: 'user', backend: 'test' });
  runRegistry.register({ channel: 'Ccancel', executionId: rec.id, kill: () => true, backend: 'test' });
  t.onTestFinished(() => { runRegistry.remove(rec.id); });

  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  dispatchCommand('!cancel', 'Ccancel', adapter);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

  assert.equal(executionRegistry.getExecution(rec.id)!.status, 'cancelled', 'record must be cancelled, not running/failed');
  // The kill-error path would later call failExecution; it must NOT flip a terminal record.
  executionRegistry.failExecution(rec.id, { durationS: 1, error: 'killed' });
  assert.equal(executionRegistry.getExecution(rec.id)!.status, 'cancelled', 'cancelled record stays cancelled');
});

// ── !cancel --all ─────────────────────────────────────────────────────────

test('!cancel --all kills all running executions for current channel, spares other channels', async (t) => {
  const adapter = new MockAdapter();
  let killedC1 = false;
  let killedC2 = false;

  runRegistry.register({ channel: 'C1', executionId: 'exec-1', kill: () => { killedC1 = true; return true; }, backend: 'test' });
  runRegistry.register({ channel: 'C2', executionId: 'exec-2', kill: () => { killedC2 = true; return true; }, backend: 'test' });
  conduitQueues.set('C1', Promise.resolve());
  t.onTestFinished(() => { runRegistry.remove('exec-1'); runRegistry.remove('exec-2'); conduitQueues.delete('C1'); });

  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  const handled = dispatchCommand('!cancel --all', 'C1', adapter);
  assert.equal(handled, true);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

  assert.equal(killedC1, true, 'execution in current channel should be killed');
  assert.equal(killedC2, false, 'execution in different channel should NOT be killed');
  assert.equal(conduitQueues.has('C1'), false);
  assert.match(adapter.posted[0].content.text, /Cancelled 1 execution/);
});

// ── retired commands ───────────────────────────────────────────────────────

test('retired thread/task/profile commands are unknown', async () => {
  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({ scheduler: null });
  for (const cmd of ['!thread cancel', '!tasks', '!dispatch thr_1', '!profile plan']) {
    assert.equal(dispatchCommand(cmd, 'C123', adapter), true);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.posted.length, 4);
  for (const post of adapter.posted) assert.match(post.content.text, /unknown command/i);
});

test('!nvtop starts live GPU monitor with sparkline view and updates the same message', async (t) => {
  const intervals = withFakeIntervals(t);
  withMockedGpuExec(t, {
    GPU: [
      '0, GPU-0, RTX 6000 Ada, 92, 18342, 49140, 67, 241\n1, GPU-1, RTX 6000 Ada, 3, 210, 49140, 41, 28',
      '0, GPU-0, RTX 6000 Ada, 75, 16000, 49140, 63, 220\n1, GPU-1, RTX 6000 Ada, 12, 512, 49140, 43, 35',
    ],
    PROC: [
      '318421, python train.py, 17980, GPU-0',
      '318421, python train.py, 15000, GPU-0\n4521, python eval.py, 256, GPU-1',
    ],
  });

  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
  });

  assert.equal(dispatchCommand('!nvtop testbox', 'C123', adapter), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(adapter.posted.length, 1);
  const firstText = adapter.posted[0].content.text;
  assert.match(firstText, /testbox/);
  assert.equal(intervals.length, 1);

  await intervals[0].fn();

  assert.equal(adapter.updated.length, 1);
  assert.match(adapter.updated[0].content.text, /eval\.py/);
  assert.match(adapter.updated[0].content.text, /75%/);
});

test('!nvtop stop stops active monitor and reports when none is running', async (t) => {
  const intervals = withFakeIntervals(t);
  withMockedGpuExec(t, {
    GPU: ['0, GPU-0, RTX 6000 Ada, 50, 12000, 49140, 55, 180'],
    PROC: ['123, python train.py, 11000, GPU-0'],
  });

  const adapter = new MockAdapter();
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
  });

  dispatchCommand('!nvtop testbox', 'CSTOP', adapter);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(intervals.length, 1);

  dispatchCommand('!nvtop stop', 'CSTOP', adapter);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(intervals.length, 0);
  assert.match(adapter.posted.at(-1).content.text, /stopped/i);

  dispatchCommand('!nvtop stop', 'CSTOP', adapter);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(adapter.posted.at(-1).content.text, /No active nvtop/i);
});


test('!compact is exact and delegates to the shared channel coordinator', async () => {
  const adapter = new MockAdapter();
  const calls: string[] = [];
  const dispatchCommand = createCommandDispatcher({
    scheduler: null,
    compactSessionByChannel: async ({ channel }) => {
      calls.push(channel);
      return { ok: true, status: 'compacted', contextUsage: null };
    },
  });
  assert.equal(dispatchCommand('!compact', 'Ccompact', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['Ccompact']);

  assert.equal(dispatchCommand('!compact now', 'Ccompact', adapter), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['Ccompact'], 'arguments must not prefix-match the exact command');
  assert.match(adapter.posted[1].content.text, /unknown command/i);
});

vi.mock('@core/gateway-generator.js', async (original) => ({
  ...await original<typeof import('../src/core/gateway-generator.js')>(),
  readGatewayYaml: () => ({ top: {}, endpoints: {
    anthropic: { plan: {}, api: {}, anthropic: {} }, openai: { openai: {} },
  } }),
}));
