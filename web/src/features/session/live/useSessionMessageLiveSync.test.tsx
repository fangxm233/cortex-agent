import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  reconnectEpoch: 0,
  liveHandler: null as null | ((event: any) => void),
  deltaHandler: null as null | ((event: any) => void),
  invalidateQueries: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: () => ({ data: undefined, isPending: false, isError: false, refetch: harness.refetch }),
    useQueryClient: () => ({
      invalidateQueries: harness.invalidateQueries,
      getQueryCache: () => ({ findAll: () => [] }),
    }),
  };
});

vi.mock('@/lib/trpc', () => {
  const trpc = (() => {
    const queryFilter = (input?: unknown) => ({ input });
    return {
      waitpoints: { list: { queryFilter } },
      sessions: {
        list: { queryFilter },
        transcript: { queryFilter },
        subagentTranscript: { queryFilter },
        pendingInteraction: { queryFilter },
      },
    };
  })();
  return { useTRPC: () => trpc };
});

vi.mock('@/features/live/LiveEventsProvider', () => ({
  useLiveConnection: () => ({ reconnectEpoch: harness.reconnectEpoch }),
  useLiveEvents: (_types: string[], handler: (event: any) => void) => {
    harness.liveHandler = handler;
  },
}));

vi.mock('./useAssistantDeltaStream', () => ({
  useAssistantDeltaStream: (_sessionId: string, enabled: boolean, handler: (event: any) => void) => {
    harness.deltaHandler = enabled ? handler : null;
  },
}));

import { useSessionMessageLiveSync, type SessionLiveState } from './useSessionMessageLiveSync';
import { registerActiveSubagentTranscript } from '@/features/session/transcript/SubagentTranscriptDetail';

const FULL_TRANSCRIPT = { sessionId: 's1', turns: [], pendingUserMessages: [] };
const COMPACT_TRANSCRIPT = { sessionId: 's1', turns: [], pendingUserMessages: [], subagentSummaries: [] };
const TODO_SNAPSHOT = {
  items: [{ content: 'Inspect state', activeForm: 'Inspecting state', status: 'in_progress' as const }],
  total: 1,
  completed: 0,
  activeLabel: 'Inspecting state',
  updatedAt: 1,
};
let observed: SessionLiveState | null = null;
let mounted: ReactTestRenderer | null = null;

function Probe({ sessionId = 's1', transcript = FULL_TRANSCRIPT, deltas = false }: {
  sessionId?: string;
  transcript?: typeof FULL_TRANSCRIPT | typeof COMPACT_TRANSCRIPT | null;
  deltas?: boolean;
}): null {
  observed = useSessionMessageLiveSync(sessionId, false, false, {
    transcript: transcript && sessionId === transcript.sessionId ? transcript : null,
    deltas,
  });
  return null;
}

beforeEach(async () => {
  harness.reconnectEpoch = 0;
  harness.liveHandler = null;
  harness.deltaHandler = null;
  harness.invalidateQueries.mockReset();
  harness.refetch.mockReset();
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
  it('drops stale status, turns, context and todos on reconnect so snapshots govern', () => {
    act(() => {
      harness.liveHandler?.({ type: 'session.status', payload: { running: true, backgroundRunning: true } });
      harness.liveHandler?.({ type: 'session.turn', payload: { numTurns: 7 } });
      harness.liveHandler?.({ type: 'session.todos', payload: { snapshot: TODO_SNAPSHOT } });
      harness.liveHandler?.({ type: 'session.context-usage', payload: {
        usedTokens: 100, contextWindow: 1000, percent: 10, accuracy: 'exact', updatedAt: '2026-10-01T00:00:00Z',
      } });
    });
    expect(observed).toMatchObject({ running: true, backgroundRunning: true, liveTurns: 7 });
    expect(observed?.contextUsage?.usedTokens).toBe(100);
    harness.reconnectEpoch = 1;
    act(() => mounted?.update(<Probe />));
    expect(observed).toMatchObject({
      running: false, backgroundRunning: false, liveTurns: null, contextUsage: null, todos: null,
    });
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ input: { sessionId: 's1' } });
  });

  it('preserves the safe auth action on a live notice', () => {
    const authAction = {
      kind: 'auth-login', noticeId: 'notice-web',
      backend: 'pi', provider: 'deepseek', authType: 'api_key',
    };

    act(() => {
      harness.liveHandler?.({
        type: 'session.message',
        payload: {
          sessionId: 's1', role: 'assistant', text: 'Authentication expired',
          noticeLevel: 'error', authAction, ts: '2026-08-01T01:00:00.000Z',
        },
      });
    });

    expect(observed?.getMessageSnapshot().liveTail[0]).toMatchObject({ authAction });
  });

  it('carries native-subagent attribution onto the live row', () => {
    // The live tail rebuilds the payload field by field. Dropping these three made every subagent
    // row look like the main agent's own output until the transcript refetched, so its prose sat in
    // the main stream and its tool chips visibly jumped into the block afterwards.
    act(() => {
      harness.liveHandler?.({
        type: 'session.message',
        payload: {
          sessionId: 's1', role: 'tool', text: '', toolName: 'Bash', toolInput: 'ls',
          subagentId: 'toolu_01abc', subagentType: 'Explore',
          subagentDescription: 'Survey the repo', subagentModel: 'claude-haiku-4-5',
          ts: '2026-08-01T01:00:00.000Z',
        },
      });
    });

    expect(observed?.getMessageSnapshot().liveTail[0]).toMatchObject({
      subagentId: 'toolu_01abc', subagentType: 'Explore', subagentDescription: 'Survey the repo',
      subagentModel: 'claude-haiku-4-5',
    });
  });

  it('carries remote device metadata onto a live tool row', () => {
    act(() => {
      harness.liveHandler?.({
        type: 'session.message',
        payload: {
          sessionId: 's1', role: 'tool', text: '', toolName: 'remote_bash', toolInput: 'pwd',
          toolDevice: 'hub', ts: '2026-08-01T01:00:00.000Z',
        },
      });
    });

    expect(observed?.getMessageSnapshot().liveTail[0].toolDevice).toBe('hub');
  });

  it('carries a lead worker action onto a live tool row', () => {
    const teamAction = { op: 'send' as const, worker: 'atlas', text: 'Continue with the next step.' };
    act(() => {
      harness.liveHandler?.({
        type: 'session.message',
        payload: {
          sessionId: 's1', role: 'tool', text: '', toolName: 'worker_send', toolInput: '{"worker":"atlas"}',
          teamAction, ts: '2026-08-01T01:00:00.000Z',
        },
      });
    });

    expect(observed?.getMessageSnapshot().liveTail[0].teamAction).toEqual(teamAction);
  });

  it('keeps a worker progress row without reading it as the lead streaming', () => {
    const worker = { name: 'atlas', sessionId: 'w1' };
    act(() => {
      harness.liveHandler?.({
        type: 'session.message',
        payload: {
          sessionId: 's1', role: 'worker-progress', text: 'Halfway through the parser.', worker,
          ts: '2026-08-01T01:00:00.000Z',
        },
      });
    });

    expect(observed?.getMessageSnapshot().liveTail).toMatchObject([
      { role: 'worker-progress', text: 'Halfway through the parser.', worker },
    ]);
    expect(observed?.streaming).toBe(false);
  });

  it('carries complete subagent spawn metadata onto a live anchor row', () => {
    const subagentSpawns = [{
      id: 'toolu_batch#0', type: 'explore', description: 'Survey the repo',
      prompt: 'Line one.\n\nLine two stays intact.',
    }];
    act(() => {
      harness.liveHandler?.({
        type: 'session.message',
        payload: {
          sessionId: 's1', role: 'tool', text: '', toolName: 'agent', toolInput: '[batch]',
          subagentSpawns, ts: '2026-08-01T01:00:00.000Z',
        },
      });
    });

    expect(observed?.getMessageSnapshot().liveTail[0].subagentSpawns).toEqual(subagentSpawns);
  });

  it('does not carry a Todo delta into the next selected session', () => {
    act(() => {
      harness.liveHandler?.({
        type: 'session.todos',
        payload: { sessionId: 's1', snapshot: TODO_SNAPSHOT },
      });
    });
    expect(observed?.todos).toEqual(TODO_SNAPSHOT);

    act(() => mounted?.update(<Probe sessionId="s2" />));

    expect(observed?.todos).toBeNull();
  });

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

  it('keeps a bounded child fallback in the compact live tail and invalidates active detail queries', async () => {
    const unregister = registerActiveSubagentTranscript('s1', 'child-1');
    try {
      await act(async () => {
        mounted?.update(<Probe transcript={COMPACT_TRANSCRIPT} />);
      });

      act(() => {
        harness.liveHandler?.({
          type: 'session.message',
          payload: {
            sessionId: 's1', role: 'assistant', text: 'child note', subagentId: 'child-1',
            ts: '2026-08-01T01:00:00.000Z',
          },
        });
      });

      expect(observed?.getMessageSnapshot().liveTail).toMatchObject([{
        subagentId: 'child-1', text: 'child note',
      }]);
      expect(harness.invalidateQueries).toHaveBeenCalledWith({ input: { sessionId: 's1' } });
      expect(harness.invalidateQueries).toHaveBeenCalledWith({ input: { sessionId: 's1', subagentId: 'child-1' } });
    } finally {
      unregister();
    }
  });

  it('does not let a child final message retire the main-agent delta preview', async () => {
    await act(async () => {
      mounted?.update(<Probe transcript={COMPACT_TRANSCRIPT} deltas />);
    });

    act(() => {
      harness.deltaHandler?.({ blockId: 'main-block', text: 'main partial' });
    });
    expect(observed?.streamingText).toBe('main partial');

    act(() => {
      harness.liveHandler?.({
        type: 'session.message',
        payload: {
          sessionId: 's1', role: 'assistant', text: 'child result', subagentId: 'child-1',
          ts: '2026-08-01T01:00:00.000Z',
        },
      });
    });

    expect(observed?.streamingText).toBe('main partial');
  });

  it('keeps structural child spawn events in the compact live tail and still invalidates detail queries', async () => {
    const unregister = registerActiveSubagentTranscript('s1', 'child-1');
    try {
      await act(async () => {
        mounted?.update(<Probe transcript={COMPACT_TRANSCRIPT} />);
      });

      act(() => {
        harness.liveHandler?.({
          type: 'session.message',
          payload: {
            sessionId: 's1', role: 'assistant', text: 'delegate deeper', subagentId: 'child-1',
            subagentSpawns: [{ id: 'grand-1', type: 'review', description: 'Review', prompt: 'Review carefully.' }],
            ts: '2026-08-01T01:00:00.000Z',
          },
        });
      });

      expect(observed?.getMessageSnapshot().liveTail).toMatchObject([{
        subagentId: 'child-1',
        subagentSpawns: [{ id: 'grand-1', type: 'review', description: 'Review', prompt: 'Review carefully.' }],
      }]);
      expect(harness.invalidateQueries).toHaveBeenCalledWith({ input: { sessionId: 's1' } });
      expect(harness.invalidateQueries).toHaveBeenCalledWith({ input: { sessionId: 's1', subagentId: 'child-1' } });
    } finally {
      unregister();
    }
  });

  it('keeps the old live-tail behavior when the transcript has no compact authority', () => {
    act(() => {
      harness.liveHandler?.({
        type: 'session.message',
        payload: {
          sessionId: 's1', role: 'assistant', text: 'child note', subagentId: 'child-1',
          ts: '2026-08-01T01:00:00.000Z',
        },
      });
    });

    expect(observed?.getMessageSnapshot().liveTail).toMatchObject([{ subagentId: 'child-1', text: 'child note' }]);
  });

  it('rewind still clears the tail and invalidates active subagent detail queries', () => {
    const unregister = registerActiveSubagentTranscript('s1', 'child-1');
    try {
      act(() => {
        harness.liveHandler?.({
          type: 'session.message',
          payload: { sessionId: 's1', role: 'assistant', text: 'main reply', ts: '2026-08-01T01:00:00.000Z' },
        });
      });
      expect(observed?.getMessageSnapshot().liveTail).toHaveLength(1);

      act(() => {
        harness.liveHandler?.({ type: 'session.rewound', payload: { sessionId: 's1' } });
      });

      expect(observed?.getMessageSnapshot().liveTail).toEqual([]);
      expect(harness.invalidateQueries).toHaveBeenCalledWith({ input: { sessionId: 's1' } });
      expect(harness.invalidateQueries).toHaveBeenCalledWith({ input: undefined });
      expect(harness.invalidateQueries).toHaveBeenCalledWith({ input: { sessionId: 's1', subagentId: 'child-1' } });
    } finally {
      unregister();
    }
  });

  it('refetches the transcript and open subagent details when a call\'s images were filed', () => {
    const unregister = registerActiveSubagentTranscript('s1', 'child-1');
    try {
      act(() => {
        harness.liveHandler?.({ type: 'session.tool-images', payload: { sessionId: 's1' } });
      });
      expect(harness.invalidateQueries).toHaveBeenCalledWith({ input: { sessionId: 's1' } });
      expect(harness.invalidateQueries).toHaveBeenCalledWith({ input: { sessionId: 's1', subagentId: 'child-1' } });
    } finally {
      unregister();
    }
  });
});
