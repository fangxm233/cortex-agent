// input:  domain/runs/continuation-sink.ts runToContinuationSink
// output: spec for replaying a run's background events as legacy ContinuationSink callbacks
// pos:    P1.5 contract — the bg holds subscribe to a run without owning proc.setContinuationSink
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { runToContinuationSink } from '../../src/domain/runs/continuation-sink.js';
import type { ContinuationSink } from '../../src/agent-adapter/types.js';
import type { RunEvent } from '../../src/domain/runs/events.js';
import type { RunObserver } from '../../src/domain/runs/request.js';
import type { AgentRun } from '../../src/domain/runs/run.js';

/** A run stub that captures the subscribed observer so tests can push synthetic events. */
function runStub(): { run: AgentRun; push: (event: RunEvent) => void; unsubscribed: () => boolean } {
  let observer: RunObserver | null = null;
  let unsubscribed = false;
  const run = {
    subscribe(o: RunObserver): () => void {
      observer = o;
      return () => { unsubscribed = true; observer = null; };
    },
  } as unknown as AgentRun;
  return { run, push: (event) => observer!.onEvent(event), unsubscribed: () => unsubscribed };
}

function recordingSink(): { sink: ContinuationSink; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sink: {
      onTurnOpen: () => { calls.push('turnOpen'); },
      onAssistantText: (text, model, subagent) => { calls.push(`text:${text}:${model ?? ''}:${subagent?.type ?? ''}`); },
      onToolUse: (name, _input, toolUseId, subagent) => { calls.push(`tool:${name}:${toolUseId ?? ''}:${subagent?.type ?? ''}`); },
      onToolResult: (toolUseId, content, isError) => { calls.push(`result:${toolUseId}:${content}:${isError}`); },
      onContextUsage: (usage) => { calls.push(`context:${usage.usedTokens}`); },
      onSubagentEnd: (parentToolUseId, status) => { calls.push(`subagentEnd:${parentToolUseId}:${status}`); },
      onResult: (result) => { calls.push(`result:${result.finalOutput ?? ''}:${result.pendingBackgroundTasks ?? 0}`); },
    },
  };
}

test('replays background-phase events to the sink in adapter order and ignores foreground', () => {
  const { run, push } = runStub();
  const { sink, calls } = recordingSink();
  runToContinuationSink(run, sink);

  push({ type: 'foreground_result', result: { sessionId: null, total_cost_usd: null, num_turns: 1, rateLimited: false, rateLimitMessage: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false, finalOutput: 'fg' } });
  // The run's own enter-background marker must NOT become the adapter's onTurnOpen.
  push({ type: 'phase', phase: 'background', pendingBackground: 1, undeliveredBackground: 0 });
  // Adapter continuation turn.
  push({ type: 'phase', phase: 'background', pendingBackground: 0, undeliveredBackground: 0 });
  push({ type: 'assistant_text', text: 'bg', model: 'm', subagent: { parentToolUseId: 'p', type: 'explore' }, phase: 'background' });
  push({ type: 'tool_use', toolUseId: 't1', name: 'Bash', input: {}, phase: 'background' });
  push({ type: 'tool_result', toolUseId: 't1', ok: false, content: 'boom', phase: 'background' });
  push({ type: 'context_usage', usedTokens: 10, contextWindow: 100, percent: 10, accuracy: 'estimate', phase: 'background' });
  push({ type: 'subagent_end', parentToolUseId: 'p', status: 'killed', phase: 'background' });
  push({ type: 'background_result', result: { sessionId: null, total_cost_usd: null, num_turns: 1, rateLimited: false, rateLimitMessage: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false, finalOutput: 'done', pendingBackgroundTasks: 0 } });
  // A foreground event interleaved must not reach the sink.
  push({ type: 'assistant_text', text: 'ignored', phase: 'foreground' });

  assert.deepEqual(calls, [
    'turnOpen',
    'text:bg:m:explore',
    'tool:Bash:t1:',
    'result:t1:boom:true',
    'context:10',
    'subagentEnd:p:killed',
    'result:done:0',
  ]);
});

test('returns the run unsubscribe function', () => {
  const { run, unsubscribed } = runStub();
  const { sink } = recordingSink();
  const off = runToContinuationSink(run, sink);
  off();
  assert.equal(unsubscribed(), true);
});
