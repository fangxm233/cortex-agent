import { describe, expect, it, vi } from 'vitest';
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
vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ currentProjectId: 'p1' }),
}));
vi.mock('@/features/projects/useProjectSessions', () => ({
  useProjectSessions: () => ({ data: [] }),
}));
vi.mock('./composer-draft', () => ({ prefillProjectDraft: vi.fn() }));

function mount() {
  let api!: ReturnType<typeof useSelectedSession>;
  function Probe() {
    api = useSelectedSession();
    return null;
  }
  act(() => { create(<SelectedSessionProvider><Probe /></SelectedSessionProvider>); });
  return () => api;
}

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
