import { describe, expect, it } from 'vitest';
import type { SessionTranscript, TranscriptMessage } from '@cortex-agent/ui-contract';
import { buildNavMarks } from './chat-nav';
import { headlineUpdate, parseWorkerMessage, plainLine, teamActionOf, updateCounts } from './team-rows';
import {
  assistantTurnCopyTargets, buildTranscriptRows, rewindStats, type ChatRow, type LiveSessionMessage,
  type TeamUpdatesRow,
} from './transcript-vm';

// Placeholder workers and text only.
const day = (min: number): string => new Date(Date.UTC(2026, 6, 7, 16, min)).toISOString();

function msg(over: Partial<TranscriptMessage>): TranscriptMessage {
  return { type: 'assistant', text: null, toolName: null, toolInput: null, ts: day(0), elapsedMs: null, ...over };
}
const human = (text: string, min: number) => msg({ type: 'user', text, ts: day(min) });
const say = (text: string, min: number) => msg({ type: 'assistant', text, ts: day(min) });
const tool = (toolName: string, toolInput: string, min: number, over: Partial<TranscriptMessage> = {}) =>
  msg({ type: 'tool', toolName, toolInput, ts: day(min), ...over });
const report = (worker: string, body: string, min: number, status = 'completed') =>
  msg({ type: 'user', systemOrigin: 'worker-result', text: `[Worker ${worker} · ${status}]\nstatus running\n\n${body}`, ts: day(min) });
const question = (worker: string, id: string, q: string, min: number) => msg({
  type: 'user', systemOrigin: 'worker-question', ts: day(min),
  text: `[Worker ${worker} · question · request_id=${id} · non-blocking]\nstatus waiting(${id})\n\nQ1: ${q}\n   Options: yes | no\n\n`
    + `Answer with worker_answer(request_id="${id}", answers={"<question text>": "<answer>"}).\n`
    + 'The user may also answer on the worker\'s own card; the first answer wins.',
});
const plan = (worker: string, id: string, min: number) => msg({
  type: 'user', systemOrigin: 'worker-question', ts: day(min),
  text: `[Worker ${worker} · plan approval · request_id=${id} · blocking]\nstatus waiting(${id})\n\nPlan file: /plans/p.md\n`
    + '# Bounded repair\n\nStep one.\n\nApprove or reject with worker_answer(request_id="x", approved=true|false, feedback="...").',
});
const progress = (worker: string, sessionId: string, text: string, min: number) =>
  msg({ type: 'worker-progress', text, worker: { name: worker, sessionId }, ts: day(min) });

const SEND = 'mcp__cortex-core__worker_send';
const ANSWER = 'mcp__cortex-core__worker_answer';

function rows(messages: TranscriptMessage[], live: LiveSessionMessage[] = [], opts = {}): ChatRow[] {
  const transcript: SessionTranscript = { sessionId: 'lead', turns: [{ turnIndex: 0, messages }] };
  return buildTranscriptRows(transcript, live, { now: new Date(day(0)), ...opts }).filter((r) => r.kind !== 'divider');
}

const cards = (list: ChatRow[]): TeamUpdatesRow[] => list.filter((r): r is TeamUpdatesRow => r.kind === 'team-updates');

describe('parseWorkerMessage', () => {
  it('reads a report without its turn status or status line', () => {
    const u = parseWorkerMessage('worker-result', '[Worker atlas · completed]\nstatus idle\n\nBuilt **the** thing.\n\nNext: test.', null)!;
    expect(u).toMatchObject({ kind: 'report', worker: 'atlas', body: 'Built **the** thing.\n\nNext: test.', line: 'Built the thing. Next: test.' });
    expect(u.outcome).toBeUndefined();
    expect(parseWorkerMessage('worker-result', '[Worker atlas · failed]\nstatus idle\n\n(no final reply)', null)?.outcome).toBe('failed');
  });

  it('reads a question without the answering instructions, and a plan by its title', () => {
    const q = parseWorkerMessage('worker-question', question('atlas', 'r1', 'Use the cache?', 0).text!, null)!;
    expect(q).toMatchObject({ kind: 'question', worker: 'atlas', requestId: 'r1', line: 'Use the cache?' });
    expect(q.body).not.toMatch(/worker_answer|first answer wins/);
    const p = parseWorkerMessage('worker-question', plan('atlas', 'r2', 0).text!, null)!;
    expect(p).toMatchObject({ kind: 'plan', requestId: 'r2', line: 'Bounded repair' });
    expect(p.body).not.toMatch(/Plan file|worker_answer/);
  });

  it('drops the unread routine updates a report or question ends with', () => {
    const tail = '\n\n[Unread routine updates]\norchard 09:40 nothing new\norchard 09:55 still waiting';
    const r = parseWorkerMessage('worker-result', `[Worker atlas · completed]\nstatus idle\n\nBuilt it.${tail}`, null)!;
    expect(r).toMatchObject({ body: 'Built it.', line: 'Built it.' });
    const q = parseWorkerMessage('worker-question', question('atlas', 'r1', 'Use the cache?', 0).text! + tail, null)!;
    expect(q).toMatchObject({ kind: 'question', line: 'Use the cache?' });
    expect(q.body).not.toMatch(/Unread|nothing new|worker_answer/);
  });

  it('leaves a header it does not recognise alone', () => {
    expect(parseWorkerMessage('worker-result', 'free text', null)).toBeNull();
    expect(parseWorkerMessage('agent-result', '[Worker atlas · completed]', null)).toBeNull();
  });

  it('plainLine flattens markdown to one line', () => {
    expect(plainLine('# Title\n- one `two`\n\n```\ncode\n```\n[link](http://x)')).toBe('Title one two link');
  });
});

describe('teamActionOf', () => {
  it('prefers the structured ref and still reads the answer request id off the summary', () => {
    const a = teamActionOf(tool(ANSWER, '{"request_id":"r9","approved":true,"feedback":"ok"}', 1, {
      teamAction: { op: 'answer', worker: 'atlas', text: 'ok', approved: true },
    }))!;
    expect(a).toMatchObject({ op: 'answer', worker: 'atlas', text: 'ok', approved: true, requestId: 'r9', partial: false });
  });

  it('parses cut-off history summaries best-effort', () => {
    const send = teamActionOf(tool(SEND, '{"worker":"atlas","message":"Continue with the \\"second\\" step and keep…', 1))!;
    expect(send).toMatchObject({ op: 'send', worker: 'atlas', text: 'Continue with the "second" step and keep', partial: true });
    const stop = teamActionOf(tool('worker_stop', '{"worker":"atlas","retire":true}', 1))!;
    expect(stop).toMatchObject({ op: 'stop', worker: 'atlas', retire: true });
    const spawn = teamActionOf(tool('worker_spawn', 'Implement the parser. Read the plan first…', 1))!;
    expect(spawn).toMatchObject({ op: 'spawn', worker: null, text: 'Implement the parser. Read the plan first', partial: true });
    const approve = teamActionOf(tool(ANSWER, '{"request_id":"r2","approved":false,"feedback":"Narrow it"}', 1))!;
    expect(approve).toMatchObject({ requestId: 'r2', approved: false, text: 'Narrow it', partial: false });
    expect(teamActionOf(tool('mcp__cortex-core__worker_list', '{}', 1))).toBeNull();
  });

  it('uses the DEBUG full input when the server sent it', () => {
    const spawn = teamActionOf(tool('worker_spawn', 'cut…', 1, {
      debug: { toolInput: { name: 'orchard', prompt: 'Full prompt', backend: 'pi', model: 'm-1' } },
    }))!;
    expect(spawn).toMatchObject({ worker: 'orchard', text: 'Full prompt', model: 'pi · m-1', partial: false });
  });
});

describe('team rows in the transcript', () => {
  it('lifts worker actions out of the tool run and folds consecutive reports into one card', () => {
    const out = rows([
      human('go on', 0),
      tool('Read', '/a.md', 1),
      tool(SEND, '{"worker":"atlas","message":"Resume"}', 2),
      tool('mcp__cortex-core__worker_list', '{}', 3),
      say('Sent.', 4),
      report('atlas', 'one', 5), report('atlas', 'two', 6),
      say('', 7),
      report('atlas', 'three', 8),
      say('Located the issue.', 9),
      report('atlas', 'four', 10),
    ]);
    expect(out.map((r) => r.kind)).toEqual(['user', 'tools', 'team-action', 'tools', 'assistant', 'team-updates', 'assistant', 'assistant', 'team-updates']);
    const [first, second] = cards(out);
    expect(first.updates.map((u) => u.line)).toEqual(['one', 'two', 'three']);
    expect(first.threads[0]).toMatchObject({ worker: 'atlas', latest: false });
    expect(second.threads[0]).toMatchObject({ worker: 'atlas', latest: true });
  });

  it('folds an answer that directly follows its request into the card, and the run continues', () => {
    const out = rows([
      plan('atlas', 'p1', 0),
      tool(ANSWER, '{"request_id":"p1","approved":true,"feedback":"Go"}', 1),
      report('atlas', 'started', 2),
      report('atlas', 'done', 3),
    ]);
    expect(out.map((r) => r.kind)).toEqual(['team-updates']);
    const [card] = cards(out);
    expect(card.updates.map((u) => u.kind)).toEqual(['plan', 'report', 'report']);
    expect(card.updates[0].answer).toMatchObject({ approved: true, text: 'Go' });
  });

  it('keeps a later answer as its own line, resolving the worker from the request', () => {
    const out = rows([
      question('atlas', 'q1', 'Which port?', 0),
      tool('Read', '/notes.md', 1),
      tool(ANSWER, '{"request_id":"q1","answers":{"Which port?":"3004"}}', 2),
    ]);
    expect(out.map((r) => r.kind)).toEqual(['team-updates', 'tools', 'team-action']);
    const action = out[2].kind === 'team-action' ? out[2].action : null;
    expect(action).toMatchObject({ op: 'answer', worker: 'atlas', text: '3004' });
    expect(cards(out)[0].updates[0].answer).toMatchObject({ text: '3004' });
  });

  it('matches a structured answer without a request id to the oldest open request of that worker', () => {
    const out = rows([
      question('atlas', 'q1', 'First?', 0),
      question('atlas', 'q2', 'Second?', 1),
      tool(ANSWER, '', 2, { teamAction: { op: 'answer', worker: 'atlas', text: 'yes' } }),
    ]);
    const [card] = cards(out);
    expect(card.updates.map((u) => u.answer?.text ?? null)).toEqual(['yes', null]);
  });

  it('groups several workers and progress rows into one card, one thread each', () => {
    const out = rows([
      progress('orchard', 'w2', 'Reading the wizard', 0),
      report('atlas', 'VM ready', 1),
      progress('orchard', 'w2', 'Checksum added', 2),
    ]);
    const [card] = cards(out);
    expect(card.updates.map((u) => u.worker)).toEqual(['orchard', 'atlas', 'orchard']);
    expect(card.threads.map((t) => [t.worker, t.updates.length, t.sessionId, t.latest])).toEqual([
      ['orchard', 2, 'w2', true], ['atlas', 1, null, true],
    ]);
  });

  it('leads a card with its latest report or request and counts routine apart', () => {
    const [card] = cards(rows([
      progress('atlas', 'w1', 'Nothing new', 0),
      report('atlas', 'Parser done', 1),
      question('atlas', 'r1', 'Ship it?', 2),
      progress('atlas', 'w1', 'Still waiting', 3),
    ]));
    expect(headlineUpdate(card.updates)).toMatchObject({ kind: 'question', line: 'Ship it?' });
    expect(updateCounts(card.updates)).toEqual({ reports: 1, routine: 2 });
    const [quiet] = cards(rows([progress('atlas', 'w1', 'Nothing new', 0), progress('atlas', 'w1', 'Still waiting', 1)]));
    expect(headlineUpdate(quiet.updates)).toMatchObject({ kind: 'progress', line: 'Still waiting' });
  });

  it('places live progress rows and live team actions like history', () => {
    const live: LiveSessionMessage[] = [
      { sessionId: 'lead', role: 'tool', text: '', toolName: 'worker_spawn', toolInput: 'Build it', ts: day(5),
        teamAction: { op: 'spawn', worker: 'nimbus', text: 'Build it', model: 'm-2' } },
      { sessionId: 'lead', role: 'worker-progress', text: 'Halfway', worker: { name: 'nimbus', sessionId: 'w3' }, ts: day(6) },
    ];
    const out = rows([human('start', 0)], live);
    expect(out.map((r) => r.kind)).toEqual(['user', 'team-action', 'team-updates']);
    expect(out[1].kind === 'team-action' && out[1].action).toMatchObject({ op: 'spawn', worker: 'nimbus', model: 'm-2' });
    expect(cards(out)[0].threads[0]).toMatchObject({ worker: 'nimbus', sessionId: 'w3' });
  });

  it('keeps pending worker messages in their own dimmed card at the tail', () => {
    const out = rows([report('atlas', 'read', 0)], [], {
      pendingUser: [{ ts: day(3), text: '[Worker atlas · completed]\nstatus idle\n\nunread', systemOrigin: 'worker-result' }],
    });
    expect(cards(out).map((c) => [c.pending ?? false, c.updates[0].line])).toEqual([[false, 'read'], [true, 'unread']]);
  });

  it('leaves an unrecognised worker message as a plain hint row', () => {
    const out = rows([msg({ type: 'user', systemOrigin: 'worker-result', text: 'legacy text', ts: day(0) })]);
    expect(out[0]).toMatchObject({ kind: 'user', systemOrigin: 'worker-result' });
  });

  it('team rows are not turns: no nav marks, copy and rewind still span them', () => {
    const out = rows([
      human('go', 0), say('Dispatching.', 1), tool(SEND, '{"worker":"atlas","message":"x"}', 2), report('atlas', 'ok', 3),
    ]);
    expect(buildNavMarks(out).map((m) => m.row)).toEqual([0]);
    expect([...assistantTurnCopyTargets(out)]).toEqual([[3, 'Dispatching.']]);
    expect(rewindStats(out, 0)).toEqual({ replies: 1, toolCalls: 1 });
  });
});
