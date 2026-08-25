// input:  mounted rail-wide session sync hook and captured live events
// output: Todo-driven sessions.list refresh regression
// pos:    Tests unscoped session snapshot convergence
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  eventTypes: [] as readonly string[],
  liveHandler: null as null | (() => void),
  invalidateQueries: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ sessions: { list: { queryFilter: () => ({ queryKey: ['sessions.list'] }) } } }),
}));

vi.mock('@/features/live/LiveEventsProvider', () => ({
  useLiveEvents: (types: readonly string[], handler: () => void) => {
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

    act(() => harness.liveHandler?.());

    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessions.list'] });
  });
});
