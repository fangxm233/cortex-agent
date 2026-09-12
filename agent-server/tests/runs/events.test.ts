// input:  domain/runs/events.ts and the NormalizedEvent / ContinuationSink shapes
// output: spec that every NormalizedEvent and ContinuationSink callback translates with its phase
// pos:    P1.1 contract — RunEvent translation is total and phase-tagged
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { continuationSinkToEvents, toRunEvent, type RunEvent } from '../../src/domain/runs/events.js';
import type { ContinuationSink } from '../../src/agent-adapter/types.js';
import type { NormalizedEvent, ToolUseSubagent } from '../../src/agent-adapter/normalize/event-types.js';
import type { AgentResult, TodoSnapshot } from '../../src/core/types/agent-types.js';

const subagent: ToolUseSubagent = {
  parentToolUseId: 'toolu_parent',
  type: 'explore',
  description: 'scout',
  prompt: 'look around',
  model: 'sonnet',
};

const snapshot: TodoSnapshot = {
  items: [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' }],
  total: 1,
  completed: 0,
  activeLabel: 'Running tests',
  updatedAt: 42,
};

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: 'sess-1',
    total_cost_usd: 0.25,
    num_turns: 3,
    rateLimited: false,
    rateLimitMessage: null,
    planFilePath: null,
    enteredPlanMode: false,
    exitedPlanMode: false,
    finalOutput: 'final',
    ...overrides,
  };
}

// Every NormalizedEvent member, with the RunEvent shape it must translate to under
// `phase: 'foreground'`. `turn_complete` is asserted separately because its phase selects the
// result kind.
function sample(kind: NormalizedEvent['type']): NormalizedEvent {
  switch (kind) {
    case 'session_started': return { type: 'session_started', sessionId: 'sess-1', sessionFile: '/tmp/s.jsonl' };
    case 'assistant_text': return { type: 'assistant_text', text: 'hi', blockId: 'b1', model: 'sonnet', subagent };
    case 'assistant_delta': return { type: 'assistant_delta', text: 'h', blockId: 'b1' };
    case 'tool_use': return { type: 'tool_use', toolUseId: 'tu-1', name: 'Bash', input: { command: 'ls' }, subagent };
    case 'tool_result': return { type: 'tool_result', toolUseId: 'tu-1', ok: true, content: 'out', subagent };
    case 'todo_update': return { type: 'todo_update', toolUseId: 'tu-2', snapshot };
    case 'ask_user_question':
      return { type: 'ask_user_question', toolUseId: 'tu-3', questions: [{ question: 'Pick', multi: true, options: ['a', 'b'] }] };
    case 'plan_mode_entered': return { type: 'plan_mode_entered', toolUseId: 'tu-4', planFilePath: '/p/plan.md' };
    case 'plan_written': return { type: 'plan_written', toolUseId: 'tu-5', path: '/p/plan.md', content: 'plan' };
    case 'context_compacted': return { type: 'context_compacted', trigger: 'auto', preTokens: 1000 };
    case 'model_fallback': return { type: 'model_fallback', originalModel: 'a', fallbackModel: 'b' };
    case 'context_usage': return { type: 'context_usage', usedTokens: 10, contextWindow: 100, percent: 10, accuracy: 'exact' };
    case 'rate_limit': return { type: 'rate_limit', raw: { message: '429' } };
    case 'cost_record':
      return {
        type: 'cost_record', provider: 'anthropic', model: 'sonnet',
        tokens_in: 1, tokens_out: 2, prompt_tokens: 3, cached_tokens: 4,
        input_tokens: 5, output_tokens: 6, cache_read_tokens: 7, cache_creation_tokens: 8,
        provider_requests: 9, cost_usd: 0.1,
      };
    case 'turn_progress': return { type: 'turn_progress', numTurns: 2 };
    case 'turn_complete': return { type: 'turn_complete', numTurns: 3, totalCostUsd: 0.4 };
    case 'subagent_activity': return { type: 'subagent_activity', parentToolUseId: 'toolu_parent', subagentType: 'explore', kind: 'assistant' };
    case 'subagent_end': return { type: 'subagent_end', parentToolUseId: 'toolu_parent', status: 'completed' };
    case 'error': return { type: 'error', message: 'boom', fatal: true };
  }
}

const PHASED_KINDS: NormalizedEvent['type'][] = [
  'assistant_text', 'assistant_delta', 'tool_use', 'tool_result', 'todo_update',
  'plan_mode_entered', 'plan_written', 'context_compacted', 'model_fallback',
  'context_usage', 'subagent_activity', 'subagent_end',
];

test('passthrough events keep their payload and carry the foreground phase', () => {
  for (const kind of PHASED_KINDS) {
    const event = sample(kind);
    const translated = toRunEvent(event, 'foreground');
    assert.equal(translated.type, kind, kind);
    assert.equal((translated as { phase?: string }).phase, 'foreground', kind);
    // The only renaming passthrough is none: every payload field survives verbatim.
    for (const [key, value] of Object.entries(event)) {
      assert.deepEqual((translated as Record<string, unknown>)[key], value, `${kind}.${key}`);
    }
  }
});

test('the same passthrough events carry the background phase', () => {
  for (const kind of PHASED_KINDS) {
    const translated = toRunEvent(sample(kind), 'background');
    assert.equal(translated.type, kind, kind);
    assert.equal((translated as { phase?: string }).phase, 'background', kind);
  }
});

test('session_started becomes engine_started with backendSessionId', () => {
  assert.deepEqual(toRunEvent(sample('session_started'), 'foreground'), {
    type: 'engine_started', backendSessionId: 'sess-1', sessionFile: '/tmp/s.jsonl',
  });
  assert.deepEqual(
    toRunEvent({ type: 'session_started', sessionId: 'sess-2' }, 'foreground'),
    { type: 'engine_started', backendSessionId: 'sess-2' },
  );
});

test('ask_user_question becomes an ask_user dialog_request', () => {
  assert.deepEqual(toRunEvent(sample('ask_user_question'), 'foreground'), {
    type: 'dialog_request', dialogId: 'tu-3', kind: 'ask_user',
    payload: [{ question: 'Pick', multi: true, options: ['a', 'b'] }],
  });
});

test('rate_limit, cost_record and turn_progress translate without a phase', () => {
  assert.deepEqual(toRunEvent(sample('rate_limit'), 'foreground'), { type: 'rate_limit', raw: { message: '429' } });
  assert.deepEqual(toRunEvent(sample('cost_record'), 'foreground'), sample('cost_record'));
  assert.deepEqual(toRunEvent(sample('turn_progress'), 'foreground'), { type: 'turn_progress', numTurns: 2 });
});

test('error translates verbatim', () => {
  assert.deepEqual(toRunEvent(sample('error'), 'foreground'), { type: 'error', message: 'boom', fatal: true });
});

test('turn_complete becomes foreground_result in the foreground phase', () => {
  assert.deepEqual(toRunEvent(sample('turn_complete'), 'foreground'), {
    type: 'foreground_result',
    result: {
      sessionId: null, total_cost_usd: 0.4, num_turns: 3,
      rateLimited: false, rateLimitMessage: null, planFilePath: null,
      enteredPlanMode: false, exitedPlanMode: false, finalOutput: null,
    },
  });
});

test('turn_complete becomes background_result in the background phase', () => {
  const event = sample('turn_complete');
  assert.equal(event.type, 'turn_complete');
  const translated = toRunEvent(event, 'background');
  assert.equal(translated.type, 'background_result');
  assert.deepEqual((translated as { result: AgentResult }).result.num_turns, 3);
});

test('the phase tag is independent of the union member for every passthrough kind', () => {
  for (const kind of PHASED_KINDS) {
    const foreground = toRunEvent(sample(kind), 'foreground');
    const done = toRunEvent(sample(kind), 'done');
    assert.equal((foreground as { phase?: string }).phase, 'foreground', kind);
    assert.equal((done as { phase?: string }).phase, 'done', kind);
  }
});

test('continuationSinkToEvents turns every callback into a background RunEvent', () => {
  const emitted: RunEvent[] = [];
  const sink: ContinuationSink = continuationSinkToEvents((event) => emitted.push(event));

  sink.onTurnOpen?.();
  assert.deepEqual(emitted.at(-1), {
    type: 'phase', phase: 'background', pendingBackground: 0, undeliveredBackground: 0,
  });

  sink.onAssistantText('continued', 'sonnet', subagent);
  assert.deepEqual(emitted.at(-1), {
    type: 'assistant_text', text: 'continued', model: 'sonnet', subagent, phase: 'background',
  });

  sink.onToolUse?.('Bash', { command: 'ls' }, 'tu-9', subagent);
  assert.deepEqual(emitted.at(-1), {
    type: 'tool_use', toolUseId: 'tu-9', name: 'Bash', input: { command: 'ls' },
    subagent, phase: 'background',
  });

  sink.onToolResult?.('tu-9', 'failed', true, subagent);
  assert.deepEqual(emitted.at(-1), {
    type: 'tool_result', toolUseId: 'tu-9', ok: false, content: 'failed',
    subagent, phase: 'background',
  });

  sink.onContextUsage?.({ usedTokens: 5, contextWindow: 50, percent: 10, accuracy: 'estimate' });
  assert.deepEqual(emitted.at(-1), {
    type: 'context_usage', usedTokens: 5, contextWindow: 50, percent: 10,
    accuracy: 'estimate', phase: 'background',
  });

  sink.onSubagentEnd?.('toolu_parent', 'killed');
  assert.deepEqual(emitted.at(-1), {
    type: 'subagent_end', parentToolUseId: 'toolu_parent', status: 'killed', phase: 'background',
  });

  sink.onResult(result({ pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 2 }));
  assert.deepEqual(emitted.at(-1), {
    type: 'background_result', result: result({ pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 2 }),
  });

  // A later turn-open reports the counts from the last result.
  sink.onTurnOpen?.();
  assert.deepEqual(emitted.at(-1), {
    type: 'phase', phase: 'background', pendingBackground: 1, undeliveredBackground: 2,
  });
});

test('continuationSinkToEvents tolerates an absent toolUseId', () => {
  const emitted: RunEvent[] = [];
  const sink = continuationSinkToEvents((event) => emitted.push(event));
  sink.onToolUse?.('Read', { path: '/x' });
  assert.deepEqual(emitted.at(-1), {
    type: 'tool_use', toolUseId: '', name: 'Read', input: { path: '/x' }, phase: 'background',
  });
});
