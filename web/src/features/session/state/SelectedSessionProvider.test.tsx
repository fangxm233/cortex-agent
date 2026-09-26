import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { SelectedSessionProvider, useSelectedSession } from './SelectedSessionProvider';
import { DRAFT_SENTINEL } from './selected-session';

// The draft's commission lives in the provider so a surface that already NAMES the commission — a
// rail row, the board — can open a draft armed with it. That makes the disarming rule part of the
// provider's contract too: the arming belongs to one draft and must never be inherited.

vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ config: { get: { queryOptions: () => ({ queryKey: ['config.get'] }) } } }),
}));
const lists = vi.hoisted(() => ({
  projectId: 'p1',
  sessions: [] as Array<{ sessionId: string; projectId: string; lastUsedAt: string; createdAt: string }>,
}));
vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ currentProjectId: lists.projectId }),
}));
vi.mock('@/features/projects/useProjectSessions', () => ({
  useProjectSessions: (projectId: string, origin: string) => ({
    data: origin === 'direct' ? lists.sessions.filter((s) => s.projectId === projectId) : [],
    isSuccess: true,
  }),
  useAllSessions: (origin: string) => ({ data: origin === 'direct' ? lists.sessions : [] }),
}));
vi.mock('@/features/session/composer/composer-draft', () => ({ prefillProjectDraft: vi.fn() }));

let rerender = () => {};

function mount() {
  let api!: ReturnType<typeof useSelectedSession>;
  function Probe() {
    api = useSelectedSession();
    return null;
  }
  const tree = () => <SelectedSessionProvider><Probe /></SelectedSessionProvider>;
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(tree()); });
  rerender = () => act(() => renderer.update(tree()));
  return () => api;
}

function session(sessionId: string, projectId: string, day: number) {
  const at = `2026-07-0${day}T00:00:00Z`;
  return { sessionId, projectId, lastUsedAt: at, createdAt: at };
}

beforeEach(() => {
  lists.projectId = 'p1';
  lists.sessions = [];
});

describe('SelectedSessionProvider latching', () => {
  it('keeps the first most-recent session when another one becomes newer', () => {
    lists.sessions = [session('a', 'p1', 1), session('b', 'p1', 2)];
    const api = mount();
    expect(api().selectedSessionId).toBe('b');

    lists.sessions = [session('a', 'p1', 3), session('b', 'p1', 2)];
    rerender();
    expect(api().selectedSessionId).toBe('b');
  });

  it('re-latches after a project switch that left the old selection behind', () => {
    lists.sessions = [session('a', 'p1', 1), session('c', 'p2', 2), session('d', 'p2', 1)];
    const api = mount();
    act(() => api().setSelectedSession('a'));

    lists.projectId = 'p2';
    rerender();
    expect(api().selectedSessionId).toBe('c');

    lists.sessions = [session('a', 'p1', 1), session('c', 'p2', 2), session('d', 'p2', 4)];
    rerender();
    expect(api().selectedSessionId).toBe('c');
  });

  it('does not replace a selection the list has not caught up with', () => {
    lists.sessions = [session('a', 'p1', 1)];
    const api = mount();
    act(() => api().setSelectedSession('fresh'));
    expect(api().selectedSessionId).toBe('a');

    lists.sessions = [session('a', 'p1', 1), session('fresh', 'p1', 2)];
    rerender();
    expect(api().selectedSessionId).toBe('fresh');
  });
});

describe('SelectedSessionProvider commission arming', () => {
  it('opens a draft already joined to the commission', () => {
    const api = mount();
    act(() => api().startCommissionDraft('cm-1'));
    expect(api().selectedSessionId).toBe(DRAFT_SENTINEL);
    expect(api().isDraft).toBe(true);
    expect(api().draftCommission).toBe('cm-1');
  });

  it('disarms on any explicit selection, including the next plain draft', () => {
    const api = mount();
    act(() => api().startCommissionDraft('cm-1'));
    act(() => api().setSelectedSession(DRAFT_SENTINEL));
    expect(api().isDraft).toBe(true);
    expect(api().draftCommission).toBeNull();
  });

  it('disarms once the draft has become a session', () => {
    // Otherwise the conversation AFTER this one would silently land on the same contract.
    const api = mount();
    act(() => api().startCommissionDraft('cm-1'));
    act(() => api().selectCreatedSession('s-9'));
    expect(api().draftCommission).toBeNull();
  });
});
