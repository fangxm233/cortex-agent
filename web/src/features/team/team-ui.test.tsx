import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { en, LangProvider, zh } from '@/i18n';
import { TeamCapsule } from './TeamRoster';
import { teamContext } from './worker-groups';
import {
  pendingQuestionText, teamRoster, teamSummaryText, workerDoing, workerStatusText,
} from './worker-roster';
import { ChatHeader } from '@/features/workbench/chat/ChatHeader';

const questions = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock('./useWorkerQuestions', () => ({ useWorkerQuestions: () => questions.current }));
vi.mock('@/features/notes/NotesProvider', () => ({
  useNotes: () => ({ isOpen: false, open: vi.fn(), close: vi.fn(), copy: { title: 'Notes' }, vm: { activeCount: 0 } }),
}));
vi.mock('@/design/dock-intake', () => ({
  useDockIntake: () => ({ canDock: false, active: false, activeKind: null, openWeb: vi.fn() }),
}));
vi.mock('@/features/workbench/chat/ChatSessionMenu', () => ({ ChatSessionMenu: () => null }));

const session = (sessionId: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    sessionId,
    projectId: 'atlas',
    name: 'cortex-' + sessionId,
    label: 'session ' + sessionId,
    createdAt: '2026-07-15T09:00:00Z',
    lastUsedAt: '2026-07-15T09:00:00Z',
    origin: 'direct',
    teamLeadId: null,
    workerName: null,
    workerRetiredAt: null,
    ...over,
  }) as SessionInfo;

const lead = session('lead');
const w1 = session('w1', { teamLeadId: 'lead', workerName: 'bench', running: true });
const w2 = session('w2', { teamLeadId: 'lead', workerName: 'docs', waitingOn: 1 });
const gone = session('w3', { teamLeadId: 'lead', workerName: 'old', workerRetiredAt: 1 });
const all = [lead, w1, w2, gone];

describe('teamContext', () => {
  it('is empty with team mode off, for a draft, or for a session with no team', () => {
    expect(teamContext(false, lead, all)).toEqual({ lead: null, workers: [] });
    expect(teamContext(false, w1, all)).toEqual({ lead: null, workers: [] });
    expect(teamContext(true, null, all)).toEqual({ lead: null, workers: [] });
    expect(teamContext(true, session('solo'), all)).toEqual({ lead: null, workers: [] });
  });

  it('resolves a worker to its lead and a lead to its workers', () => {
    expect(teamContext(true, w1, all)).toEqual({ lead, workers: [] });
    expect(teamContext(true, lead, all).workers.map((w) => w.sessionId)).toEqual(['w1', 'w2', 'w3']);
    // A lead that is not in the list leaves the worker without a breadcrumb.
    expect(teamContext(true, w1, [w1])).toEqual({ lead: null, workers: [] });
  });
});

function render(node: JSX.Element): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => { r = create(<LangProvider>{node}</LangProvider>); });
  return r;
}

const NOW = Date.parse('2026-07-15T10:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe('worker roster', () => {
  const idle = session('idle', { teamLeadId: 'lead', workerName: 'idle', lastUsedAt: ago(12) });
  const run = session('run', { teamLeadId: 'lead', workerName: 'run', running: true, lastUsedAt: ago(4) });
  const you = session('you', { teamLeadId: 'lead', workerName: 'you', running: true, awaitingInput: true });
  const onLead = session('onlead', { teamLeadId: 'lead', workerName: 'onlead', running: true, waitingOnLead: 1 });
  const signal = session('signal', { teamLeadId: 'lead', workerName: 'signal', waitingOn: 2 });

  it('orders active workers needs you → running → waiting → idle and keeps retired apart', () => {
    const roster = teamRoster([idle, signal, run, gone, onLead, you]);
    expect(roster.active.map((w) => w.sessionId)).toEqual(['you', 'run', 'signal', 'onlead', 'idle']);
    expect(roster.retired.map((w) => w.sessionId)).toEqual(['w3']);
  });

  it('summarizes counts and leaves out the zero ones', () => {
    expect(teamSummaryText([run, you, idle, onLead], en)).toBe('4 workers · 1 running · 1 needs you');
    expect(teamSummaryText([idle], en)).toBe('1 worker');
    expect(teamSummaryText([run, signal], zh)).toBe('2 个 worker · 1 运行');
  });

  it('says how long a worker has run or idled, and only where the record knows', () => {
    expect(workerStatusText(run, NOW, en, 'en')).toBe('running 4m');
    expect(workerStatusText({ ...run, backgroundRunning: true }, NOW, en, 'en')).toBe('running');
    expect(workerStatusText(idle, NOW, en, 'en')).toBe('idle 12m');
    expect(workerStatusText({ ...idle, lastUsedAt: '' }, NOW, en, 'en')).toBe('idle');
    expect(workerStatusText(you, NOW, en, 'en')).toBe('needs you');
    expect(workerStatusText(onLead, NOW, en, 'en')).toBe('waiting on lead');
    expect(workerStatusText(signal, NOW, en, 'en')).toBe('waiting');
    expect(workerStatusText(run, NOW, zh, 'zh')).toBe('运行中 4分钟');
  });

  it('describes the work: question, then current task while running, then brief, then a distinct label', () => {
    const todos = { items: [], total: 2, completed: 1, activeLabel: 'Running the sweep', updatedAt: 0 };
    const briefed = { ...run, todos, workerBrief: 'Sweep the grasp set', label: 'run' };
    expect(workerDoing(briefed, 'Asks: Which seed?')).toBe('Asks: Which seed?');
    expect(workerDoing(briefed, null)).toBe('Running the sweep');
    expect(workerDoing({ ...briefed, running: false }, null)).toBe('Sweep the grasp set');
    expect(workerDoing({ ...idle, label: 'idle' }, null)).toBeNull();
    expect(workerDoing({ ...idle, label: 'Renamed by hand' }, null)).toBe('Renamed by hand');
  });

  it('reads the pending question, or the plan title', () => {
    const ask = { requestId: 'r', blocking: true, questions: [{ question: 'Keep the 60 min timeout?', header: '', options: [], multiSelect: false }] };
    expect(pendingQuestionText({ askUser: ask, plan: null }, en)).toBe('Asks: Keep the 60 min timeout?');
    expect(pendingQuestionText({ askUser: null, plan: { requestId: 'p', planContent: '\n# Port the adapter\nsteps', planFilePath: null } }, en))
      .toBe('Plan: Port the adapter');
    expect(pendingQuestionText(null, en)).toBeNull();
  });
});

describe('TeamCapsule', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    questions.current = {};
  });
  afterEach(() => vi.unstubAllGlobals());

  const capsule = (r: ReactTestRenderer) => r.root.findAll((n) => n.type === 'button' && n.props['data-team-capsule'] !== undefined);
  const rows = (r: ReactTestRenderer) => r.root.findAll((n) => n.type === 'button' && n.props['data-worker-row'] !== undefined);
  const text = (r: ReactTestRenderer) => JSON.stringify(r.toJSON());

  it('renders nothing without an active worker', () => {
    expect(render(<TeamCapsule workers={[]} onOpen={vi.fn()} />).toJSON()).toBeNull();
    expect(render(<TeamCapsule workers={[gone]} onOpen={vi.fn()} />).toJSON()).toBeNull();
  });

  it('stacks at most six dots, attention first, beside the summary', () => {
    const many = Array.from({ length: 7 }, (_, i) => session(`m${i}`, { teamLeadId: 'lead', workerName: `m${i}` }));
    const asking = session('ask', { teamLeadId: 'lead', workerName: 'ask', awaitingInput: true });
    const r = render(<TeamCapsule workers={[...many, w1, asking]} onOpen={vi.fn()} />);
    const stack = r.root.findByProps({ 'data-worker-stack': '' });
    const dots = stack.findAllByType('span').filter((n) => n !== stack);
    expect(dots).toHaveLength(6);
    expect(dots[0].props.style.background).toBe('var(--proto-amber)');
    expect(dots[1].props.style.background).toBe('var(--proto-accent)');
    expect(text(r)).toContain('9 workers');
    expect(text(r)).toContain('1 needs you');
    expect(r.root.findAll((n) => n.props['data-team-panel'] !== undefined)).toHaveLength(0);
    act(() => r.unmount());
  });

  it('opens the panel with one row per worker, opens a worker and closes', () => {
    const onOpen = vi.fn();
    const asking = session('ask', { teamLeadId: 'lead', workerName: 'ask', awaitingInput: true });
    questions.current = { ask: 'Asks: Which seed?' };
    const r = render(<TeamCapsule workers={[w2, w1, asking, gone]} onOpen={onOpen} />);
    act(() => capsule(r)[0].props.onClick({ stopPropagation: vi.fn() }));
    expect(capsule(r)[0].props['aria-expanded']).toBe(true);
    expect(rows(r).map((n) => n.props['data-worker-row'])).toEqual(['ask', 'w1', 'w2']);
    expect(text(r)).toContain('Team · 3');
    expect(text(r)).toContain('Asks: Which seed?');
    act(() => rows(r)[1].props.onClick());
    expect(onOpen).toHaveBeenCalledWith('w1');
    expect(r.root.findAll((n) => n.props['data-team-panel'] !== undefined)).toHaveLength(0);
    act(() => r.unmount());
  });

  it('folds retired workers at the bottom until asked', () => {
    const onOpen = vi.fn();
    const r = render(<TeamCapsule workers={[w1, gone]} onOpen={onOpen} />);
    act(() => capsule(r)[0].props.onClick({ stopPropagation: vi.fn() }));
    const toggle = r.root.findByProps({ 'data-team-retired': '' });
    expect(text(r)).toContain('Retired 1');
    expect(rows(r).map((n) => n.props['data-worker-row'])).toEqual(['w1']);
    act(() => toggle.props.onClick());
    expect(rows(r).map((n) => n.props['data-worker-row'])).toEqual(['w1', 'w3']);
    act(() => rows(r)[1].props.onClick());
    expect(onOpen).toHaveBeenCalledWith('w3');
    act(() => r.unmount());
  });
});

describe('ChatHeader lead breadcrumb', () => {
  const header = (parent?: { title: string; onSelect: () => void } | null) => (
    <ChatHeader title="Worker" running={false} projectName="atlas" backendSessionId={null} sessionName={null}
      metadataSession={null} parent={parent} />
  );

  it('is absent without a parent', () => {
    const r = render(header(null));
    expect(r.root.findAll((n) => n.props['data-lead-crumb'] !== undefined && n.type === 'button')).toHaveLength(0);
    act(() => r.unmount());
  });

  it('names the lead before the title and selects it on click', () => {
    const onSelect = vi.fn();
    const r = render(header({ title: 'Plan the port', onSelect }));
    const crumb = r.root.findByProps({ 'data-lead-crumb': '' });
    expect(crumb.props.title).toBe('Open lead session · Plan the port');
    act(() => crumb.props.onClick());
    expect(onSelect).toHaveBeenCalledOnce();
    act(() => r.unmount());
  });
});
