import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { WorkerStrip } from './WorkerStrip';
import { teamContext } from './worker-groups';
import { ChatHeader } from '@/features/workbench/chat/ChatHeader';

vi.mock('@/features/notes/NotesProvider', () => ({
  useNotes: () => ({ isOpen: false, open: vi.fn(), close: vi.fn(), copy: { title: 'Notes' }, vm: { activeCount: 0 } }),
}));
vi.mock('@/design/dock-intake', () => ({
  useDockIntake: () => ({ canDock: false, active: false, activeKind: null, openWeb: vi.fn() }),
}));
vi.mock('@/features/workbench/chat/ChatSessionMenu', () => ({ ChatSessionMenu: () => null }));
vi.mock('@/shell/useShellModals', () => ({
  useShellModals: () => ({ sessionIdOpen: false, openSessionId: vi.fn(), closeSessionId: vi.fn() }),
}));

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

describe('WorkerStrip', () => {
  it('renders nothing without an active worker', () => {
    expect(render(<WorkerStrip workers={[]} onOpen={vi.fn()} />).toJSON()).toBeNull();
    expect(render(<WorkerStrip workers={[gone]} onOpen={vi.fn()} />).toJSON()).toBeNull();
  });

  it('shows one chip per active worker with its status dot, and opens it on click', () => {
    const onOpen = vi.fn();
    const r = render(<WorkerStrip workers={[w1, w2, gone]} onOpen={onOpen} />);
    const chips = r.root.findAll((n) => n.type === 'button' && n.props['data-worker-chip']);
    expect(chips.map((c) => c.props['data-worker-chip'])).toEqual(['w1', 'w2']);
    expect(JSON.stringify(r.toJSON())).toContain('bench');
    const dot = (c: (typeof chips)[number]) => c.findAllByType('span')[0].props.style;
    expect(dot(chips[0]).background).toBe('var(--proto-accent)');
    expect(dot(chips[1]).border).toBe('1.5px solid var(--proto-muted-3)');
    act(() => chips[1].props.onClick());
    expect(onOpen).toHaveBeenCalledWith('w2');
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
