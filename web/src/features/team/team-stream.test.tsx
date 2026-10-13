import { describe, expect, it } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { SessionInfo, SessionTranscript, TranscriptMessage } from '@cortex-agent/ui-contract';
import { en, LangProvider } from '@/i18n';
import { buildTranscriptRows, type ChatRow, type TeamUpdatesRow } from '@/features/session/transcript/transcript-vm';
import { LeadWaitingLine, TeamRow, TeamStreamProvider } from './TeamStreamRows';
import { findWorker, spawnedWorker, threadSummary, updateTimeRange, waitedWorkers } from './team-stream';

// Placeholder workers and text only.
const session = (name: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: `w-${name}`, projectId: 'atlas', name: `cortex-${name}`, label: null, origin: 'direct',
  createdAt: '2026-07-15T09:00:00Z', lastUsedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  teamLeadId: 'lead', workerName: name, workerRetiredAt: null, ...over,
}) as SessionInfo;

const at = (min: number): string => new Date(Date.UTC(2026, 6, 15, 16, min)).toISOString();
const msg = (over: Partial<TranscriptMessage>): TranscriptMessage =>
  ({ type: 'assistant', text: null, toolName: null, toolInput: null, ts: at(0), elapsedMs: null, ...over });
const report = (worker: string, body: string, min: number): TranscriptMessage =>
  msg({ type: 'user', systemOrigin: 'worker-result', text: `[Worker ${worker} · completed]\nstatus running\n\n${body}`, ts: at(min) });
const routine = (worker: string, text: string, min: number): TranscriptMessage =>
  msg({ type: 'worker-progress', text, worker: { name: worker, sessionId: `w-${worker}` }, ts: at(min) });
const ask = (worker: string, min: number): TranscriptMessage => msg({
  type: 'user', systemOrigin: 'worker-question', ts: at(min),
  text: `[Worker ${worker} · question · request_id=q1 · non-blocking]\nstatus waiting(q1)\n\nQ1: Which port?`,
});

function rows(messages: TranscriptMessage[]): ChatRow[] {
  const transcript: SessionTranscript = { sessionId: 'lead', turns: [{ turnIndex: 0, messages }] };
  return buildTranscriptRows(transcript, [], { now: new Date(at(0)) }).filter((r) => r.kind !== 'divider');
}

function render(node: JSX.Element, workers: SessionInfo[], leadRunning = false): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<LangProvider><TeamStreamProvider workers={workers} leadRunning={leadRunning}>{node}</TeamStreamProvider></LangProvider>);
  });
  return r;
}

const text = (r: ReactTestRenderer): string => JSON.stringify(r.toJSON());
const statuses = (r: ReactTestRenderer): string[] =>
  r.root.findAll((n) => typeof n.type === 'string' && n.props['data-thread-status'] !== undefined).map((n) => n.props['data-thread-status']);

describe('team stream helpers', () => {
  it('finds a worker by session, then by name with the active holder first', () => {
    const old = session('atlas', { sessionId: 'old', workerRetiredAt: 1 });
    const cur = session('atlas', { sessionId: 'cur' });
    expect(findWorker([old, cur], 'atlas')?.sessionId).toBe('cur');
    expect(findWorker([old, cur], 'atlas', 'old')?.sessionId).toBe('old');
    expect(findWorker([old, cur], null)).toBeNull();
  });

  it('matches an unnamed spawn to its worker by the recorded brief', () => {
    const w = session('orchard', { workerBrief: 'Implement the parser for the new format.' });
    expect(spawnedWorker([w], 'Implement the parser for the new format. Then run the scoped tests and')?.sessionId).toBe('w-orchard');
    expect(spawnedWorker([w], 'Something else entirely, not this worker')).toBeNull();
  });

  it('waits on running and machine-waiting workers only', () => {
    const list = [
      session('a', { running: true }), session('b', { waitingOn: 1 }), session('c', { awaitingInput: true }),
      session('d', { running: true, waitingOnLead: 1 }), session('e'), session('f', { running: true, workerRetiredAt: 1 }),
    ];
    expect(waitedWorkers(list).map((w) => w.workerName)).toEqual(['a', 'b']);
  });

  it('summarises a card without the turn status', () => {
    const [card] = rows([ask('atlas', 0), report('atlas', 'one', 1), report('atlas', 'two', 2)]) as TeamUpdatesRow[];
    expect(threadSummary(card.threads[0], en)).toBe('Question unanswered · 2 reports');
    expect(updateTimeRange(card.updates, new Date(at(0)))).toMatch(/^\d\d:\d\d – \d\d:\d\d$/);
  });
});

describe('team rows', () => {
  it('shows live status only on the worker\'s latest card and never the turn status', () => {
    const list = rows([report('atlas', 'first', 0), msg({ text: 'noted', ts: at(1) }), report('atlas', 'second', 2)]);
    const cards = list.filter((r): r is TeamUpdatesRow => r.kind === 'team-updates');
    const r = render(<>{cards.map((c) => <TeamRow key={c.id} row={c} />)}</>, [session('atlas', { running: true })]);
    expect(statuses(r)).toEqual(['history', 'running']);
    expect(text(r)).not.toContain('completed');
    act(() => r.unmount());
  });

  it('turns a worker with an open question amber in its latest card', () => {
    const [card] = rows([ask('atlas', 0)]) as TeamUpdatesRow[];
    const r = render(<TeamRow row={card} />, [session('atlas', { waitingOnLead: 1, awaitingInput: true })]);
    expect(statuses(r)).toEqual(['waiting']);
    expect(text(r)).toContain(en.wbTeamQuestionWaiting);
    act(() => r.unmount());
  });

  it.each([{}, { workerRetiredAt: 1, awaitingInput: true }])('ignores unanswered history when the worker is no longer awaiting input: %j', (over) => {
    const [card] = rows([ask('atlas', 0)]) as TeamUpdatesRow[];
    const r = render(<TeamRow row={card} />, [session('atlas', over)]);
    expect(statuses(r)).not.toContain('waiting');
    expect(text(r)).not.toContain(en.wbTeamQuestionOpen);
    act(() => r.unmount());
  });

  it('opens the timeline and an entry\'s full text', () => {
    const [card] = rows([report('atlas', 'Short line\n\nMore **detail**', 0), report('atlas', 'next', 1)]) as TeamUpdatesRow[];
    const r = render(<TeamRow row={card} />, []);
    act(() => r.root.find((n) => n.props.role === 'button' && n.props['aria-expanded'] === false).props.onClick());
    const items = r.root.findAll((n) => typeof n.type === 'string' && n.props['data-team-update'] !== undefined);
    expect(items).toHaveLength(2);
    act(() => items[0].props.onClick());
    expect(r.root.findAll((n) => n.props['data-team-update-body'] !== undefined)).toHaveLength(1);
    act(() => r.unmount());
  });

  it('leads with the latest report, counts routine apart and shows routine quieter', () => {
    const [card] = rows([report('atlas', 'Parser done', 0), routine('atlas', 'Nothing new', 1), routine('atlas', 'Still idle', 2)]) as TeamUpdatesRow[];
    expect(threadSummary(card.threads[0], en)).toBe('1 report · 2 routine');
    const r = render(<TeamRow row={card} />, []);
    const headline = r.root.find((n) => typeof n.type === 'string' && n.props['data-team-headline'] !== undefined);
    expect(headline.props['data-team-headline']).toBe('report');
    expect(text(r)).toContain('Parser done');
    expect(text(r)).not.toContain('Still idle');
    act(() => r.root.find((n) => n.props.role === 'button' && n.props['aria-expanded'] === false).props.onClick());
    const ink = r.root.findAll((n) => typeof n.type === 'string' && n.props['data-team-update'] !== undefined)
      .map((n) => {
        const line = (n.children[1] as ReactTestInstance).children[0] as ReactTestInstance;
        return [n.props['data-team-update'], line.props.style.color];
      });
    expect(ink).toEqual([
      ['report', 'var(--proto-ink-2)'], ['progress', 'var(--proto-muted)'], ['progress', 'var(--proto-muted)'],
    ]);
    act(() => r.unmount());
  });

  it('a routine-only card shows its latest routine line, muted', () => {
    const [card] = rows([routine('atlas', 'Nothing new', 0), routine('atlas', 'Still idle', 1)]) as TeamUpdatesRow[];
    expect(threadSummary(card.threads[0], en)).toBe('2 routine');
    const r = render(<TeamRow row={card} />, []);
    const headline = r.root.find((n) => typeof n.type === 'string' && n.props['data-team-headline'] !== undefined);
    expect(headline.props['data-team-headline']).toBe('progress');
    expect(headline.props.style.color).toBe('var(--proto-muted)');
    expect(text(r)).toContain('Still idle');
    act(() => r.unmount());
  });

  it('the lead line names the worker it waits on, and stays away while the lead runs', () => {
    const workers = [session('atlas', { waitingOn: 1 }), session('docs')];
    const idle = render(<LeadWaitingLine />, workers);
    expect(text(idle)).toContain('atlas');
    act(() => idle.unmount());
    const busy = render(<LeadWaitingLine />, workers, true);
    expect(busy.toJSON()).toBeNull();
    act(() => busy.unmount());
  });
});
