// input:  mounted session live-sync hook and captured pending/delivery events
// output: synchronous message-authority snapshot regression
// pos:    Verifies live authority is readable before React renders queued state
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  liveHandler: null as null | ((event: any) => void),
  invalidateQueries: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
  };
});

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => {
    const queryFilter = (input?: unknown) => ({ input });
    return {
      sessions: {
        list: { queryFilter },
        transcript: { queryFilter },
        pendingInteraction: { queryFilter },
      },
    };
  },
}));

vi.mock('@/features/live/LiveEventsProvider', () => ({
  useLiveConnection: () => ({ reconnectEpoch: 0 }),
  useLiveEvents: (_types: string[], handler: (event: any) => void) => {
    harness.liveHandler = handler;
  },
}));

vi.mock('./useAssistantDeltaStream', () => ({ useAssistantDeltaStream: () => {} }));

import { useSessionMessageLiveSync, type SessionLiveState } from './useSessionMessageLiveSync';

const TRANSCRIPT = { sessionId: 's1', turns: [], pendingUserMessages: [] };
let observed: SessionLiveState | null = null;
let mounted: ReactTestRenderer | null = null;

function Probe(): null {
  observed = useSessionMessageLiveSync('s1', false, false, { transcript: TRANSCRIPT });
  return null;
}

beforeEach(async () => {
  harness.liveHandler = null;
  harness.invalidateQueries.mockReset();
  observed = null;
  await act(async () => {
    mounted = create(<Probe />, { unstable_isConcurrent: true } as any);
  });
});

afterEach(async () => {
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
});

describe('useSessionMessageLiveSync message authority snapshot', () => {
  it('updates synchronously for pending and delivered events before consumers render state', () => {
    const readSnapshot = observed?.getMessageSnapshot;
    const initialRender = observed;
    expect(readSnapshot).toBeTypeOf('function');

    act(() => {
      harness.liveHandler?.({
        type: 'session.message',
        payload: {
          sessionId: 's1', role: 'user', text: 'accepted', pending: true,
          pendingId: 'pin-1', ts: '2026-08-01T01:00:00.000Z',
        },
      });
      expect(observed).toBe(initialRender);
      expect(readSnapshot?.()).toEqual({
        liveTail: [],
        pendingUser: [{
          id: 'pin-1', text: 'accepted', ts: '2026-08-01T01:00:00.000Z', attachments: undefined,
        }],
      });
    });

    const pendingRender = observed;
    act(() => {
      harness.liveHandler?.({
        type: 'session.message.delivered',
        payload: {
          sessionId: 's1', pendingId: 'pin-1',
          messageTs: '2026-08-01T01:00:00.000Z', committedTs: '2026-08-01T01:00:01.000Z',
        },
      });
      expect(observed).toBe(pendingRender);
      expect(readSnapshot?.()).toEqual({
        liveTail: [{
          sessionId: 's1', role: 'user', text: 'accepted',
          ts: '2026-08-01T01:00:01.000Z', attachments: undefined,
        }],
        pendingUser: [],
      });
    });
  });
});
