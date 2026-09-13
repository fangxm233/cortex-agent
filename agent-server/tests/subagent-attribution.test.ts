// input:  a delegating parent's registered execution and a child's run events
// output: the two guards that keep child attribution from feeding itself forever
// pos:    Tests live subagent attribution into a parent transcript
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';

import { runRegistry } from '../src/core/run-registry.js';
import { parentNoticeSink } from '../src/orchestration/subagent-attribution.js';
import { _test } from '../src/domain/agents/subagent/runner.js';
import type { RunEvent } from '../src/domain/runs/events.js';
import type { SubagentNotice } from '../src/agent-adapter/pi/event-parser.js';
import type { SubagentRunRequest } from '../src/domain/agents/subagent/runner.js';

const CHANNEL = 'C-attribution';
const PARENT_SESSION = 'sess-parent';

/**
 * A registered execution whose live run records every event ingested into its stream.
 *
 * The attribution sink is a producer into the run's one stream: it resolves the execution by key
 * and calls `run.ingestExternal(toRunEvent(notice, run.phase))`. `phase` is part of the run shape
 * the sink reads (production tags each notice with whatever phase the parent is in when it lands).
 */
function register(executionId: string, trackSessionId: string | null): RunEvent[] {
  const pushed: RunEvent[] = [];
  const run = {
    phase: 'foreground' as const,
    ingestExternal: (event: RunEvent): boolean => { pushed.push(event); return true; },
    steer: async () => 'refused' as const,
    respondToDialog: () => false,
  };
  runRegistry.register({
    threadId: null, channel: CHANNEL, agentSlotId: null, executionId,
    kind: 'local', kill: () => true, backend: 'test', trackSessionId,
    run,
  });
  return pushed;
}

function notice(text: string): SubagentNotice {
  return {
    ref: 'toolu_parent#0', type: 'general-purpose', description: 'd',
    model: null, backend: 'claude', kind: 'assistant_text', text,
  };
}

afterEach(() => {
  for (const exec of runRegistry.getAll()) runRegistry.remove(exec.registryKey);
});

test('the sink pushes into the execution it resolved, and follows it across a retry', () => {
  const parent = register('exec-parent', PARENT_SESSION);
  const sink = parentNoticeSink(PARENT_SESSION, CHANNEL);
  assert.ok(sink, 'a mid-turn parent with an ingest seam must produce a sink');

  sink!(notice('from the child'));
  assert.equal(parent.length, 1);
  const first = parent[0] as Extract<RunEvent, { type: 'assistant_text' }>;
  assert.equal(first.type, 'assistant_text');
  assert.equal(first.text, 'from the child');
  assert.equal(first.phase, 'foreground', 'the notice is re-tagged with the parent run\'s phase');

  // A retry re-registers the same executionId with a fresh run: the sink follows the key.
  const retried = register('exec-parent', PARENT_SESSION);
  sink!(notice('after the retry'));
  assert.equal(retried.length, 1, 'the sink must resolve the key again, not cache the run');
});

test('the sink goes quiet when its parent turn ends, even if the child is alone on the channel', () => {
  register('exec-parent', PARENT_SESSION);
  const sink = parentNoticeSink(PARENT_SESSION, CHANNEL);
  assert.ok(sink);

  // The parent's turn ends; its background child outlives it and is now the only live execution on
  // the channel. Resolving by channel here would hand the child its own events back — the notice →
  // ingestExternal → event → notice loop that starves the daemon's event loop.
  runRegistry.remove('exec-parent');
  const child = register('exec-child', null);

  assert.doesNotThrow(() => sink!(notice('orphaned child work')));
  assert.equal(child.length, 0, 'a child must never be resolved as its own attribution target');
});

test('a child notice observer drops events that already carry subagent attribution', () => {
  const notices: SubagentNotice[] = [];
  const request = {
    ref: 'toolu_parent#0',
    task: { description: 'd', prompt: 'p', subagent_type: 'general-purpose' },
    onNotice: (n: SubagentNotice) => { notices.push(n); },
  } as unknown as SubagentRunRequest;
  const observer = _test.claudeNoticeObserver(request);

  observer.onEvent!({ type: 'assistant_text', text: 'my own prose', phase: 'foreground' });
  assert.equal(notices.length, 1, 'the child\'s own prose is forwarded');

  // Pushed in from outside by parentNoticeSink: forwarding it would send it straight back.
  const subagent = { parentToolUseId: 'toolu_parent#0', type: null, model: null };
  observer.onEvent!({ type: 'assistant_text', text: 'echo', phase: 'foreground', subagent });
  observer.onEvent!({
    type: 'tool_use', toolUseId: 't1', name: 'Bash', input: {}, phase: 'foreground', subagent,
  });
  observer.onEvent!({
    type: 'tool_result', toolUseId: 't1', ok: true, content: 'out', phase: 'foreground', subagent,
  });
  assert.equal(notices.length, 1, 'attributed events must not be re-forwarded');
});
