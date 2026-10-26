import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { SelectedSessionProvider, useSelectedSession } from './SelectedSessionProvider';
import { DRAFT_SENTINEL } from './selected-session';

vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ config: { get: { queryOptions: () => ({ queryKey: ['config.get'] }) } } }),
}));
const lists = vi.hoisted(() => ({
  projectId: 'p1' as string | null,
  directLoaded: true,
  scheduledLoaded: true,
  scheduled: [] as Array<{ sessionId: string; projectId: string; lastUsedAt: string; createdAt: string }>,
  sessions: [] as Array<{ sessionId: string; projectId: string; lastUsedAt: string; createdAt: string }>,
}));
vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ currentProjectId: lists.projectId }),
}));
vi.mock('@/features/projects/useProjectSessions', () => ({
  useProjectSessions: (projectId: string, origin: string) => ({
    data: (origin === 'direct' ? lists.sessions : lists.scheduled).filter((s) => s.projectId === projectId),
    isSuccess: origin === 'direct' ? lists.directLoaded : lists.scheduledLoaded,
  }),
  useAllSessions: (origin: string) => ({ data: origin === 'direct' ? lists.sessions : [] }),
}));
vi.mock('@/features/session/composer/composer-draft', () => ({ prefillProjectDraft: vi.fn() }));

let rerender = () => {};
let unmount = () => {};
afterEach(() => unmount());

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
  unmount = () => act(() => renderer.unmount());
  return () => api;
}

function session(sessionId: string, projectId: string, day: number) {
  const at = `2026-07-0${day}T00:00:00Z`;
  return { sessionId, projectId, lastUsedAt: at, createdAt: at };
}

beforeEach(() => {
  lists.projectId = 'p1';
  lists.sessions = [];
  lists.scheduled = [];
  lists.directLoaded = true;
  lists.scheduledLoaded = true;
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

describe('default project draft', () => {
  it('opens a new conversation on a fresh empty project', () => {
    const api = mount();
    expect(api().selectedSessionId).toBe(DRAFT_SENTINEL);
    expect(api().isDraft).toBe(true);
  });

  it('opens a draft after the last conversation disappears', () => {
    lists.sessions = [session('a', 'p1', 1)];
    const api = mount();
    lists.sessions = [];
    rerender();
    expect(api().isDraft).toBe(true);
  });

  it('does not latch the default draft across project switches', () => {
    lists.sessions = [session('a', 'p1', 1), session('b', 'p3', 1)];
    const api = mount();
    lists.projectId = 'p2';
    rerender();
    expect(api().isDraft).toBe(true);
    lists.projectId = 'p3';
    rerender();
    expect(api().selectedSessionId).toBe('b');
  });

  it('falls back to draft for a stale selection without another conversation', () => {
    const api = mount();
    act(() => api().setSelectedSession('missing'));
    expect(api().isDraft).toBe(true);
  });

  it('does not latch the default draft when a conversation arrives', () => {
    const api = mount();
    lists.sessions = [session('a', 'p1', 1)];
    rerender();
    expect(api().selectedSessionId).toBe('a');
  });

  it('keeps an explicitly chosen draft when a conversation arrives', () => {
    const api = mount();
    act(() => api().setSelectedSession(DRAFT_SENTINEL));
    lists.sessions = [session('a', 'p1', 1)];
    rerender();
    expect(api().isDraft).toBe(true);
  });

  it('defaults to draft with scheduled runs but still allows selecting a run', () => {
    lists.scheduled = [session('run', 'p1', 1)];
    const api = mount();
    expect(api().isDraft).toBe(true);
    act(() => api().setSelectedSession('run'));
    expect(api().selectedSessionId).toBe('run');
    expect(api().isDraft).toBe(false);
  });

  it.each(['directLoaded', 'scheduledLoaded'] as const)('waits for %s before treating the project as empty', (key) => {
    lists[key] = false;
    const api = mount();
    expect(api().selectedSessionId).toBeNull();
    expect(api().isDraft).toBe(false);
    lists[key] = true;
    rerender();
    expect(api().isDraft).toBe(true);
  });

  it('does not create a default draft without a current project', () => {
    lists.projectId = null;
    expect(mount()().isDraft).toBe(false);
  });

  it('keeps the created session while waiting for its list row', () => {
    const api = mount();
    act(() => api().selectCreatedSession('created'));
    expect(api().selectedSessionId).toBe('created');
    expect(api().isDraft).toBe(false);
    lists.sessions = [session('created', 'p1', 1)];
    rerender();
    expect(api().selectedSessionId).toBe('created');
    expect(api().pendingCreatedSession).toBeNull();
  });

  it('carries a clean draft into the created session and starts the next draft off', () => {
    const api = mount();
    act(() => api().setDraftSelection({ clean: true }));
    expect(api().draftSelection.clean).toBe(true);
    act(() => api().selectCreatedSession('created'));
    expect(api().pendingCreatedSession).toMatchObject({ sessionId: 'created', clean: true });
    expect(api().draftSelection.clean).toBeUndefined();
    act(() => api().setSelectedSession(DRAFT_SENTINEL));
    expect(api().isDraft).toBe(true);
    expect(api().draftSelection.clean).toBeUndefined();
  });
});
