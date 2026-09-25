import '../../_test-home.js'; // MUST be first import — repoints CORTEX_HOME before paths bind

import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { STORE_DIR } from '../../../src/core/paths.js';
import { ConversationHistoryRepo } from '../../../src/store/conversation-history-repo.js';
import { handleSessionsTranscript } from '../../../src/domain/ui-service/query/sessions.js';
import type { SessionTranscript, TranscriptMessage, UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const DIR = path.join(STORE_DIR, 'transcript-delta-tests');

type FlatRow = { turnIndex: number; message: TranscriptMessage };

function flatten(transcript: SessionTranscript): FlatRow[] {
  return transcript.turns.flatMap((turn) => turn.messages.map((message) => ({ turnIndex: turn.turnIndex, message })));
}

/** The client half of the protocol, kept deliberately naive: index in, index out. */
function applyDelta(rows: FlatRow[], transcript: SessionTranscript): FlatRow[] {
  const delta = transcript.delta;
  if (!delta) return flatten(transcript);
  const next = rows.slice();
  for (const row of delta.changed) next[row.index] = { turnIndex: row.turnIndex, message: row.message };
  next.length = delta.total;
  return next;
}

test('replaying deltas converges on exactly the whole transcript, append after append', async () => {
  const repo = new ConversationHistoryRepo(DIR);
  const sid = 'sess-delta-convergence';
  const deps = { conversationHistory: repo } as unknown as UiServiceDeps;
  const read = (since?: string) =>
    handleSessionsTranscript(deps, { sessionId: sid, compactSubagents: true, ...(since ? { since } : {}) });

  const child = { id: 'delta-child-1', type: 'explore', description: 'Look' } as const;
  // Every append shape that can create a row, extend one, or reach back and rewrite an older one.
  const steps: (() => Promise<unknown>)[] = [
    () => repo.appendUser(sid, { text: 'open', ts: '2026-09-09T00:00:00.000Z' }),
    () => repo.appendAssistant(sid, { text: 'partial', ts: '2026-09-09T00:00:01.000Z' }),
    () => repo.appendAssistant(sid, { text: 'partial then whole', ts: '2026-09-09T00:00:02.000Z' }),
    () => repo.appendTool(sid, {
      toolName: 'Agent', toolInput: 'Look', ts: '2026-09-09T00:00:03.000Z', toolUseId: 'toolu-a',
      subagentSpawns: [{ id: child.id, type: child.type, description: child.description, prompt: 'Look around.' }],
    }),
    () => repo.appendTool(sid, { toolName: 'Grep', toolInput: 'x', ts: '2026-09-09T00:00:04.000Z', subagent: child }),
    () => repo.appendToolResult(sid, { toolUseId: 'toolu-a', content: 'y'.repeat(50_000), isError: false }),
    () => repo.appendSubagentEnd(sid, { subagentId: child.id, status: 'completed', ts: '2026-09-09T00:00:05.000Z' }),
    () => repo.appendInteractionCreated(sid, {
      id: 'int-1', kind: 'ask-user', text: 'which?', ts: '2026-09-09T00:00:06.000Z',
      payload: { questions: [{ question: 'which?', header: 'pick', options: [{ label: 'a' }, { label: 'b' }] }] } as never,
    }),
    () => repo.appendInteractionResolved(sid, { id: 'int-1', status: 'answered', resolvedVia: 'web', text: 'a', ts: '2026-09-09T00:00:07.000Z' }),
    () => repo.appendAssistant(sid, {
      text: 'decide', ts: '2026-09-09T00:00:08.000Z',
      decisions: [{ id: 'dec-1', title: 'ship it', body: 'now' }] as never,
    }),
    () => repo.appendDecisionAction(sid, { decisionId: 'dec-1', action: 'approve', ts: '2026-09-09T00:00:09.000Z' }),
    () => repo.appendUser(sid, { text: 'next turn', ts: '2026-09-09T00:00:10.000Z' }),
  ];

  await repo.clear(sid);
  await steps[0]();
  let transcript = await read();
  assert.equal(transcript.delta, undefined, 'the first read is whole');
  let rows = flatten(transcript);
  let cursor = transcript.cursor;

  for (const step of steps.slice(1)) {
    await step();
    transcript = await read(cursor);
    rows = applyDelta(rows, transcript);
    cursor = transcript.cursor;
    const whole = await read();
    assert.deepEqual(rows, flatten(whole), 'the replayed rows match a whole read after every append');
  }

  // A rewind rewrites the file: the epoch moves, the cursor is refused, and the client is handed a
  // whole transcript rather than a delta it could not apply.
  await repo.truncateFromTurn(sid, 1);
  const afterRewind = await read(cursor);
  assert.equal(afterRewind.delta, undefined, 'a void cursor falls back to a whole transcript');
  assert.deepEqual(
    afterRewind.turns.map((turn) => turn.turnIndex),
    [0],
    'the rewound turn is gone',
  );
  assert.notEqual(afterRewind.cursor!.split(':')[0], cursor!.split(':')[0]);
});
