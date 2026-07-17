// input:  Node test runner + startup/scheduled-runner helpers
// output: startup DM + scheduled success lifecycle tests
// pos:    Verify startup DM and scheduled success path flow
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sendStartupDmIfConfigured, buildStartupMessage } from '../src/entry/startup-notify.js';
import { MockAdapter } from '../src/platform/testing.js';

test('sendStartupDmIfConfigured posts one startup message to the admin channel', async () => {
  const adapter = new MockAdapter({ adminChannel: 'D0AH43A75EZ' });

  const sent = await sendStartupDmIfConfigured(adapter, {
    machine: 'local',
  });

  assert.equal(sent, true);
  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].destination.type, 'system-notice');
  assert.equal(adapter.posted[0].content.text, buildStartupMessage({ machine: 'local' }));
});

test('sendStartupDmIfConfigured returns false when no admin channel configured', async () => {
  const adapter = new MockAdapter();

  const sent = await sendStartupDmIfConfigured(adapter, {
    machine: 'local',
  });

  assert.equal(sent, false);
  assert.equal(adapter.posted.length, 0);
});

test('sendStartupDmIfConfigured includes restart reason when provided', async () => {
  const adapter = new MockAdapter({ adminChannel: 'D0AH43A75EZ' });

  await sendStartupDmIfConfigured(adapter, {
    machine: 'local',
    restartReason: 'code change: src/app.ts',
  });

  assert.equal(adapter.posted.length, 1);
  assert.equal(
    adapter.posted[0].content.text,
    buildStartupMessage({ machine: 'local', restartReason: 'code change: src/app.ts' }),
  );
});

test('scheduled success path creates thread and runs via thread system', async () => {
  const appSource = fs.readFileSync(new URL('../src/domain/scheduling/jobs/scheduled-task.ts', import.meta.url), 'utf8');
  // Capture the full block: passScheduledGuards + runScheduledTask + runScheduledTaskAsync + executeScheduledThread
  // The self-register call at the end marks the boundary.
  const match = appSource.match(/function passScheduledGuards[\s\S]*?\n}\n\n\/\/ Self-register/);
  assert.ok(match, 'expected scheduled-task functions in scheduled-task.ts');
  let rawSource = match[0]
    .replace(/\bexport\s+/g, '')  // strip export keywords (not valid in new Function body)
    .replace(/\n\/\/ Self-register[\s\S]*$/, '');  // strip trailing self-register block
  // The test passes _adapter as a new Function param; map ctx.adapter to _adapter
  rawSource = rawSource.replace(/ctx\.adapter!/g, '_adapter!');
  rawSource = rawSource.replace(/ctx\.bus!/g, '_bus');
  rawSource = rawSource.replace(/\ballConfigsRateLimited\b/g, '_allConfigsRateLimited');
  rawSource = rawSource.replace(/\bgetOutboundQueue\b/g, '_getOutboundQueue');
  // channelRepo is imported from @store/channel-repo.js (outside captured block);
  // replace with a mock.
  rawSource = rawSource.replace(/\bchannelRepo\b/g, '_channelRepo');
  // ctx.buildInteractiveCallbacks is imported from job-registry (outside extracted block);
  // replace with a mock fn that returns undefined (no interactive callbacks in test).
  rawSource = rawSource.replace(/ctx\.buildInteractiveCallbacks/g, '_buildInteractiveCallbacks');
  // Strip TypeScript type annotations via esbuild (bundled with tsx)
  const esbuild = await import('esbuild');
  const { code: functionSource } = await esbuild.transform(rawSource, { loader: 'ts', target: 'esnext' });

  const executionRegistry = {
    getRunningExecutions() { return []; },
  };

  const statusUpdates = [];
  const app = {
    postMessage: async (dest, content, opts?) => {
      // dest is a Destination object; extract channel for the MessageRef
      const channel = typeof dest === 'string' ? dest : 'C123';
      return { conduit: channel, messageId: 'status-ts', threadId: opts?.threadId };
    },
    updateMessage: async (ref, content) => { statusUpdates.push({ channel: ref.conduit, messageId: ref.messageId, text: content.text }); },
  };

  const sessionRegistered = [];
  const sessionStore = {
    generateSessionName() { return 'cortex-test'; },
    registerSession(name, opts) { sessionRegistered.push({ name, ...opts }); },
  };
  const projectStore = { resolveFromMessage: () => ({ id: 'my-project' }) };

  const createThreadCalls = [];
  const createThread = (channel, opts) => {
    createThreadCalls.push({ channel, ...opts });
    return { id: 'thread-sched-1' };
  };

  const runThreadExecCalls = [];
  const runThreadExec = async (threadId, opts) => {
    runThreadExecCalls.push({ threadId });
    return {
      lastAgentResult: { total_cost_usd: 1.23, num_turns: 4, finalOutput: 'scheduled run finished', sessionId: 'uuid-test' },
      totalCostUsd: 1.23,
      totalNumTurns: 4,
    };
  };

  const costRecords = [];

  const runScheduledTask = new Function(
    'executionRegistry',
    'scheduledTaskActive',
    'hasRunningExecutionForSchedule',
    'pendingTaskTracker',
    'normalizeSkillCommandPrefix',
    'isValidDispatchPrompt',
    '_bus',
    'getActiveProfile',
    'projectStore',
    'detectProject',
    'getActiveBackend',
    'getClaudeMode',
    '_adapter',
    'buildUserProcessingMessage',
    'maybeNotifyCodexLowUsage',
    'recordCost',
    'console',
    'sessionStore',
    'buildSessionTag',
    'createThread',
    'runThreadExec',
    'buildProgressUpdater',
    'computeElapsed',
    'formatMetricsSuffix',
    'finalizeThreadSuccess',
    'planScheduledDispatch',
    'threadStore',
    'sessionRepo',
    'continueThread',
    '_allConfigsRateLimited',
    '_getOutboundQueue',
    '_channelRepo',
    '_buildInteractiveCallbacks',
    `${functionSource}; return runScheduledTask;`
  )(
    executionRegistry,
    new Map(),
    () => false,
    { getPendingTasksForSchedule: () => [] },
    (message) => message,
    (value) => value != null && typeof value === 'string' && value.trim().length > 0,
    { publish: () => {} },
    () => 'default',
    projectStore,
    () => 'proj-scheduled',
    () => 'claude',
    () => 'api',
    app,
    () => 'processing',
    async () => {},
    (record) => { costRecords.push(record); },
    console,
    sessionStore,
    (name, id) => { const parts = []; if (name) parts.push(name); if (id) parts.push(`\`${id}\``); return parts.length ? parts.join(' \u00b7 ') + ' | ' : ''; },
    createThread,
    runThreadExec,
    () => undefined,
    (startTime) => { const s = (Date.now() - startTime) / 1000; return { elapsedStr: s.toFixed(1), elapsedS: s }; },
    ({ costUsd, numTurns }) => { const t = numTurns != null ? ` \u00b7 ${numTurns} turns` : ''; const c = costUsd != null ? ` \u00b7 $${costUsd.toFixed(4)}` : ''; return `${t}${c}`; },
    async (adapter, channel, statusMsg, { startTime, sessionName, result, threadResult, project, trigger, label, sessionKind, statusPrefix }) => {
      if (result?.sessionId) {
        sessionStore.registerSession(sessionName, {
          sessionId: result.sessionId, channel,
          backend: 'claude', kind: sessionKind,
          label,
        });
      }
      if (threadResult.totalCostUsd) {
        costRecords.push({ project, trigger, cost_usd: threadResult.totalCostUsd, num_turns: threadResult.totalNumTurns });
      }
      if (statusMsg) {
        statusUpdates.push({ channel, messageId: statusMsg.messageId, text: `✅ Done | cortex-test (1.0s)` });
      }
    },
    // planScheduledDispatch \u2014 default to fresh in this test (legacy success-path is the fresh branch).
    async ({ fallbackChannel }) => ({ kind: 'fresh', channel: fallbackChannel }),
    // threadStore stub \u2014 fresh branch never reads it.
    { findActive: () => null, get: () => null, set: () => {} },
    // sessionRepo stub.
    { getSessionAsync: async () => undefined },
    // continueThread \u2014 only used by continue-thread branch.
    async () => ({ lastAgentResult: null, totalCostUsd: 0, totalNumTurns: 0 }),
    // allConfigsRateLimited \u2014 always allow in tests
    () => false,
    // getOutboundQueue \u2014 return null so durable paths fall through to adapter directly
    () => null,
    // channelRepo stub \u2014 resolves projectId 'my-project' \u2192 channel 'C123'
    { getProjectChannel: async (projectId: string) => projectId === 'my-project' ? 'C123' : null },
    // buildInteractiveCallbacks \u2014 no interactive callbacks in test
    () => undefined,
  );

  runScheduledTask({
    message: 'nightly check',
    projectId: 'my-project',
    scheduleTaskId: 'sched-1',
    profileName: 'default',
  });
  // Wait for the async IIFE to complete
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Verify thread was created with scheduler template
  // Channel is projectId — the adapter resolves conduit through getProjectConduits at send time.
  assert.equal(createThreadCalls.length, 1);
  assert.equal(createThreadCalls[0].channel, 'my-project');
  assert.equal(createThreadCalls[0].templateName, 'scheduler');
  assert.equal(createThreadCalls[0].metadata.scheduleTaskId, 'sched-1');
  assert.equal(createThreadCalls[0].metadata.trigger, 'scheduled');

  // Verify thread was run
  assert.equal(runThreadExecCalls.length, 1);
  assert.equal(runThreadExecCalls[0].threadId, 'thread-sched-1');

  // Verify session was registered
  assert.equal(sessionRegistered.length, 1);
  assert.equal(sessionRegistered[0].sessionId, 'uuid-test');
  assert.equal(sessionRegistered[0].kind, 'scheduled');

  // Verify cost was recorded
  assert.equal(costRecords.length, 1);
  assert.equal(costRecords[0].trigger, 'scheduled');
  assert.equal(costRecords[0].cost_usd, 1.23);

  // Verify status message was updated to success
  const lastUpdate = statusUpdates[statusUpdates.length - 1];
  assert.ok(lastUpdate.text.includes('✅'), 'expected success status update');
});
