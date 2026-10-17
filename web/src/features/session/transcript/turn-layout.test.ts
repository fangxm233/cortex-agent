import { describe, expect, it } from 'vitest';
import type { ChatRow } from './chat-row';
import { copyHosts, isLongForm, itemIndexes, layoutTurns, LONG_FORM_CHARS, type TurnItem } from './turn-layout';

const user = (text: string, extra: Partial<Extract<ChatRow, { kind: 'user' }>> = {}): ChatRow => ({ kind: 'user', text, ...extra });
const say = (text: string, extra: Partial<Extract<ChatRow, { kind: 'assistant' }>> = {}): ChatRow => ({ kind: 'assistant', text, streaming: false, ...extra });
const tools = (n = 1): ChatRow => ({ kind: 'tools', count: n, calls: Array.from({ length: n }, () => ({ kind: 'Bash', input: 'ls' })) });
const thought = (text = 'hmm'): ChatRow => ({ kind: 'thinking', text });
const hint = (systemOrigin: Extract<ChatRow, { kind: 'user' }>['systemOrigin'], extra: Partial<Extract<ChatRow, { kind: 'user' }>> = {}): ChatRow =>
  ({ kind: 'user', text: '<system-reminder>\nsignal\n</system-reminder>', systemOrigin, ...extra });
const plan = (): ChatRow => ({ kind: 'interaction', subtype: 'plan', text: 'plan' });

/** The layout as compact tokens: `row:<index>:<role>` and `work:<indexes joined>[:live]`. */
function shape(items: TurnItem[]): string[] {
  return items.map((item) => item.kind === 'row'
    ? `row:${item.index}:${item.role}`
    : `work:${item.indexes.join(',')}${item.live ? ':live' : ''}`);
}

function covers(rows: ChatRow[], items: TurnItem[]): void {
  const seen = items.flatMap(itemIndexes).sort((a, b) => a - b);
  expect(seen).toEqual(rows.map((_, i) => i));
}

describe('layoutTurns', () => {
  it('folds a settled turn into its work and answer', () => {
    const rows = [user('go'), thought(), tools(3), say('checking the parser'), tools(2), say('Done: the parser drops it.')];
    const items = layoutTurns(rows);
    expect(shape(items)).toEqual(['row:0:opener', 'work:1,2,3,4', 'row:5:answer']);
    covers(rows, items);
  });

  it('keeps the work open and the trailing text as the answer while the turn is live', () => {
    const rows = [user('go'), tools(3), say('checking the parser'), tools(2), say('Writing it up', { preview: true })];
    expect(shape(layoutTurns(rows, { live: true }))).toEqual(['row:0:opener', 'work:1,2,3:live', 'row:4:answer']);
  });

  it('moves the trailing text into the work as soon as the agent acts again', () => {
    const rows = [user('go'), tools(3), say('checking the parser'), tools(2)];
    expect(shape(layoutTurns(rows, { live: true }))).toEqual(['row:0:opener', 'work:1,2,3:live']);
    // The same rows, settled: the last thing said is the answer, the tool run after it joins the work.
    expect(shape(layoutTurns(rows))).toEqual(['row:0:opener', 'work:1,3', 'row:2:answer']);
  });

  it('joins tool calls after the final text to the work before it', () => {
    const rows = [user('go'), tools(4), say('note'), tools(1), say('Final answer'), tools(1), plan()];
    expect(shape(layoutTurns(rows))).toEqual(['row:0:opener', 'work:1,2,3,5', 'row:4:answer', 'row:6:pinned']);
  });

  it('splits the work around a plan the reader acted on', () => {
    const rows = [user('go'), tools(2), say('planning'), plan(), tools(5), say('implementing'), tools(3), say('Shipped.')];
    expect(shape(layoutTurns(rows))).toEqual(['row:0:opener', 'work:1,2', 'row:3:pinned', 'work:4,5,6', 'row:7:answer']);
  });

  it('pins long working notes, files, decisions, spawned workers and armed waitpoints without splitting the work', () => {
    const long = say('x'.repeat(LONG_FORM_CHARS));
    const file = say('here', { attachments: [{ name: 'a.png', path: 'p', type: 'image' } as never] });
    const spawn: ChatRow = { kind: 'team-action', action: { op: 'spawn', worker: 'w', text: 'brief', partial: false, model: null, requestId: null, ts: null } };
    const send: ChatRow = { kind: 'team-action', action: { op: 'send', worker: 'w', text: 'hi', partial: false, model: null, requestId: null, ts: null } };
    const wait: ChatRow = { kind: 'waitpoint', wait: { label: 'train', intent: null, ts: null } };
    const rows = [user('go'), tools(1), long, tools(1), file, spawn, send, tools(1), wait, say('Waiting on the run.')];
    expect(shape(layoutTurns(rows))).toEqual([
      'row:0:opener', 'work:1,3,6,7', 'row:2:pinned', 'row:4:pinned', 'row:5:pinned', 'row:8:pinned', 'row:9:answer',
    ]);
  });

  it('leaves a lone tool run and a run of thoughts as their own lines', () => {
    expect(shape(layoutTurns([user('go'), tools(2), say('ok')]))).toEqual(['row:0:opener', 'row:1:plain', 'row:2:answer']);
    expect(shape(layoutTurns([user('go'), thought(), thought(), say('ok')]))).toEqual(['row:0:opener', 'row:1:plain', 'row:2:plain', 'row:3:answer']);
  });

  it('opens a segment when a signal wakes the agent, not when work resumes', () => {
    const rows = [
      user('train it'), tools(2), say('Started; waiting for the signal.'),
      hint('external-signal'), tools(2), say('Training finished: loss 0.12.'),
      hint('resume'), tools(1), say('Continued after the rate limit.'),
    ];
    expect(shape(layoutTurns(rows))).toEqual([
      'row:0:opener', 'row:1:plain', 'row:2:answer',
      // The resume hint is part of the woken segment's work, so the reply before it was a working note.
      'row:3:opener', 'work:4,5,6,7', 'row:8:answer',
    ]);
  });

  it('folds a background agent result that arrived mid-action, and opens on one that woke the agent', () => {
    const folded = [user('go'), tools(1), hint('agent-result'), tools(1), say('done')];
    expect(shape(layoutTurns(folded))).toEqual(['row:0:opener', 'work:1,2,3', 'row:4:answer']);
    const woke = [user('go'), tools(1), say('Running it in the background.'), hint('agent-result'), say('It found two bugs.')];
    expect(shape(layoutTurns(woke))).toEqual(['row:0:opener', 'row:1:plain', 'row:2:answer', 'row:3:opener', 'row:4:answer']);
  });

  it('pins a subagent still running once the turn has ended', () => {
    const sub: ChatRow = { kind: 'subagent', id: 'a', agentType: 'explore', description: 'map', prompt: null, model: null, status: 'running', toolCount: 3, children: [] };
    const rows = [user('go'), tools(1), sub, say('Started a background explorer.')];
    expect(shape(layoutTurns(rows))).toEqual(['row:0:opener', 'row:1:plain', 'row:2:pinned', 'row:3:answer']);
    expect(shape(layoutTurns(rows, { live: true }))).toEqual(['row:0:opener', 'work:1,2:live', 'row:3:answer']);
  });

  it('keeps unread messages pinned at the tail of the live turn', () => {
    const rows = [user('go'), tools(1), say('note'), tools(1), user('also this', { pending: true })];
    expect(shape(layoutTurns(rows, { live: true }))).toEqual(['row:0:opener', 'work:1,2,3:live', 'row:4:pinned']);
  });

  it('opens on worker reports but not on routine worker updates', () => {
    const update = (kind: 'report' | 'progress'): ChatRow => ({
      kind: 'team-updates', id: kind, threads: [],
      updates: [{ kind, worker: 'w', sessionId: null, body: 'b', line: 'b', ts: null }],
    });
    const rows = [user('go'), tools(1), say('note'), update('progress'), tools(1), say('Spawned.'), update('report'), say('Merged.')];
    expect(shape(layoutTurns(rows))).toEqual([
      'row:0:opener', 'work:1,2,4', 'row:3:pinned', 'row:5:answer', 'row:6:opener', 'row:7:answer',
    ]);
  });

  it('measures the work from its opener to the row that ended it', () => {
    const rows = [user('go', { ts: '2026-10-17T10:00:00Z' }), tools(2), say('note', { ts: '2026-10-17T10:01:00Z' }), tools(1), say('done', { ts: '2026-10-17T10:08:05Z' })];
    const work = layoutTurns(rows).find((item) => item.kind === 'work');
    expect(work).toMatchObject({ stats: { toolCalls: 3, subagents: 0, startTs: '2026-10-17T10:00:00Z', endTs: '2026-10-17T10:08:05Z' } });
  });

  it('covers every row exactly once across a mixed transcript', () => {
    const rows: ChatRow[] = [
      { kind: 'divider', text: 'TODAY' }, user('a'), thought(), tools(2), say('n'), plan(), tools(1), say('A'),
      hint('external-signal'), tools(3), say(''), say('B'), user('b'), say('C', { preview: true }),
    ];
    covers(rows, layoutTurns(rows));
    covers(rows, layoutTurns(rows, { live: true }));
  });
});

describe('isLongForm', () => {
  it('reads headings, tables and long notes as written for the reader', () => {
    expect(isLongForm('Checking the parser next.')).toBe(false);
    expect(isLongForm('## Findings\nshort')).toBe(true);
    expect(isLongForm('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true);
    expect(isLongForm('字'.repeat(LONG_FORM_CHARS))).toBe(true);
  });
});

describe('copyHosts', () => {
  it('hangs the copy action on the last item of the segment holding the target', () => {
    const rows = [user('go'), tools(1), say('note'), tools(1), say('answer'), tools(1), user('next', { pending: true })];
    const items = layoutTurns(rows, { live: true });
    // The target is the trailing tool run (folded into the work); the unread message is skipped.
    const hosts = copyHosts(items, new Map([[5, 'note\n\nanswer']]), rows);
    const host = [...hosts.keys()][0];
    expect(items[host]).toMatchObject({ kind: 'work' });
    expect([...hosts.values()]).toEqual(['note\n\nanswer']);
  });
});
