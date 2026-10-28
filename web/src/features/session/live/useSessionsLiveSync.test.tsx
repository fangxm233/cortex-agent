import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  eventTypes: [] as readonly string[],
  liveHandler: null as null | ((event: { type: string }) => void),
  invalidateQueries: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    sessions: { list: { queryFilter: () => ({ queryKey: ['sessions.list'] }) } },
    projects: { list: { queryFilter: () => ({ queryKey: ['projects.list'] }) } },
  }),
}));

vi.mock('@/features/live/LiveEventsProvider', () => ({
  useLiveEvents: (types: readonly string[], handler: (event: { type: string }) => void) => {
    harness.eventTypes = types;
    harness.liveHandler = handler;
  },
}));

import { useSessionsLiveSync } from './useSessionsLiveSync';

function Probe(): null {
  useSessionsLiveSync();
  return null;
}

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  harness.eventTypes = [];
  harness.liveHandler = null;
  harness.invalidateQueries.mockReset();
  act(() => {
    mounted = create(<Probe />);
  });
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
});

describe('useSessionsLiveSync', () => {
  it('refreshes session snapshots when any session updates its Todo list', () => {
    expect(harness.eventTypes).toContain('session.todos');

    act(() => harness.liveHandler?.({ type: 'session.todos' }));

    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessions.list'] });
    expect(harness.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['projects.list'] });
  });

  it('refreshes both lists when a project is deleted elsewhere', () => {
    expect(harness.eventTypes).toEqual(expect.arrayContaining(['session.deleted', 'project.deleted']));

    act(() => harness.liveHandler?.({ type: 'project.deleted' }));

    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessions.list'] });
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects.list'] });
  });
});
