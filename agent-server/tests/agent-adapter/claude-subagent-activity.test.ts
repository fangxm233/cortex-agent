// input:  ClaudeSession stream-json lines that carry parent_tool_use_id
// output: OC-11 native-subagent census specs (§17 G4-SA5/G4-SA6) and the additive-dispatch pin
// pos:    Claude print subagent-linkage wiring tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { _test } from '../../src/agent-adapter/claude/adapter.js';

const FAKE_STREAM = { write() {}, end() {} } as any;

interface Seen {
  census: Array<{ parentToolUseId: string; subagentType: string | null; kind: string }>;
  assistantText: string[];
  toolUses: Array<{ name: string; toolUseId: string }>;
  progress: Array<{ num_turns: number }>;
}

function seen(): Seen {
  return { census: [], assistantText: [], toolUses: [], progress: [] };
}

function turnFor(out: Seen) {
  return {
    resolve: () => {}, reject: () => {},
    resultData: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    askUserQuestions: [], finalOutput: null, longestOutput: null, turnCount: 0,
    onProgress: (p: any) => { out.progress.push(p); },
    onAssistantMessage: (text: string) => { out.assistantText.push(text); },
    onAssistantDelta: null,
    onToolUse: (name: string, _input: unknown, toolUseId: string) => {
      out.toolUses.push({ name, toolUseId });
    },
    onToolResult: null,
    onCompact: null,
    onContextUsage: null,
    onSubagentActivity: (parentToolUseId: string, subagentType: string | null, kind: string) => {
      out.census.push({ parentToolUseId, subagentType, kind });
    },
    rawStream: FAKE_STREAM, txtStream: FAKE_STREAM, killed: false,
  };
}

function sessionWith(out: Seen, t: { onTestFinished: (fn: () => void) => void }) {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());
  s.currentTurn = turnFor(out);
  return s;
}

function assistantLine(extra: Record<string, unknown> = {}, blocks?: unknown[]): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-fixture', content: blocks ?? [{ type: 'text', text: 'hello' }] },
    ...extra,
  });
}

function userLine(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'sub-call-1', content: 'ok' }] },
    ...extra,
  });
}

test('a parent line emits no census event, whether parent_tool_use_id is absent or null', (t) => {
  const out = seen();
  const s = sessionWith(out, t);

  s.handleLine(assistantLine());
  s.handleLine(assistantLine({ parent_tool_use_id: null }));
  s.handleLine(userLine());
  s.handleLine(userLine({ parent_tool_use_id: null }));

  assert.deepEqual(out.census, []);
});

test('a subagent assistant line emits exactly one assistant-kind census event', (t) => {
  const out = seen();
  const s = sessionWith(out, t);

  s.handleLine(assistantLine({ parent_tool_use_id: 'toolu_agent_1', subagent_type: 'explore' }));

  assert.deepEqual(out.census, [
    { parentToolUseId: 'toolu_agent_1', subagentType: 'explore', kind: 'assistant' },
  ]);
});

test('a subagent tool-result line emits exactly one tool_result-kind census event', (t) => {
  const out = seen();
  const s = sessionWith(out, t);

  s.handleLine(userLine({ parent_tool_use_id: 'toolu_agent_1' }));

  assert.deepEqual(out.census, [
    { parentToolUseId: 'toolu_agent_1', subagentType: null, kind: 'tool_result' },
  ]);
});

test('subagentType is null unless the line carries a string subagent_type', (t) => {
  const out = seen();
  const s = sessionWith(out, t);

  s.handleLine(assistantLine({ parent_tool_use_id: 'toolu_agent_1' }));
  s.handleLine(assistantLine({ parent_tool_use_id: 'toolu_agent_1', subagent_type: 7 }));

  assert.deepEqual(out.census.map(item => item.subagentType), [null, null]);
});

test('a replay echo carrying parent_tool_use_id emits no census event', (t) => {
  const out = seen();
  const s = sessionWith(out, t);

  s.handleLine(userLine({ parent_tool_use_id: 'toolu_agent_1', isReplay: true }));

  assert.deepEqual(out.census, []);
});

// D-ADDITIVE: the discriminator ADDS an event; it never diverts a subagent line away from the
// handlers it reaches today. adapter.ts is shared by every Cortex session, so re-routing would
// change assistant streaming and turn counting for every product surface.
test('a subagent assistant line still reaches every handler it reaches today', (t) => {
  const out = seen();
  const s = sessionWith(out, t);

  s.handleLine(assistantLine({ parent_tool_use_id: 'toolu_agent_1', subagent_type: 'explore' }, [
    { type: 'text', text: 'subagent speaking' },
    { type: 'tool_use', id: 'sub-call-1', name: 'Bash', input: { command: 'true' } },
  ]));

  assert.deepEqual(out.assistantText, ['subagent speaking']);
  assert.deepEqual(out.toolUses, [{ name: 'Bash', toolUseId: 'sub-call-1' }]);
  assert.equal(s.currentTurn.turnCount, 1);
  assert.deepEqual(out.progress.map((p: any) => p.num_turns), [1]);
  assert.equal(out.census.length, 1);
});
