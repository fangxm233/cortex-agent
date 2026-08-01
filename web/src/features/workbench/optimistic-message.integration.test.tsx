// input:  mounted CenterChat/Composer, deferred mutations, captured live events
// output: production optimistic-send wiring and authority-race regressions
// pos:    Mounted desktop optimistic sender integration specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import type { LiveSessionMessage, PendingUserMessage } from './transcript-vm';

const harness = vi.hoisted(() => ({
  projectId: 'atlas',
  sessions: [] as any[],
  transcripts: {} as Record<string, any>,
  selection: {} as any,
  selectionListeners: new Set<() => void>(),
  sendMutateAsync: vi.fn(),
  createAndSendMutateAsync: vi.fn(),
  selectCreatedSession: vi.fn(),
  invalidateQueries: vi.fn(),
  liveState: {} as any,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (options: any) => {
      if (options.__kind === 'sessions.list') return { data: harness.sessions, isPending: false };
      if (options.__kind === 'sessions.transcript') {
        const sessionId = options.input.sessionId as string;
        if (sessionId && !harness.transcripts[sessionId]) {
          harness.transcripts[sessionId] = emptyTranscript(sessionId);
        }
        return { data: sessionId ? harness.transcripts[sessionId] : undefined, isPending: false };
      }
      throw new Error(`Unexpected query: ${String(options.__kind)}`);
    },
    useMutation: (options: any) => {
      if (options.__kind === 'sessions.send') {
        return { mutateAsync: harness.sendMutateAsync, isPending: false };
      }
      if (options.__kind === 'sessions.createAndSend') {
        return { mutateAsync: harness.createAndSendMutateAsync, isPending: false };
      }
      return { mutate: vi.fn(), isPending: false };
    },
    useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
  };
});

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => {
    const query = (kind: string) => ({
      queryOptions: (input: unknown) => ({ __kind: kind, input }),
      queryFilter: (input?: unknown) => ({ __kind: kind, input }),
    });
    const mutation = (kind: string) => ({
      mutationOptions: () => ({ __kind: kind }),
    });
    return {
      sessions: {
        list: query('sessions.list'),
        transcript: query('sessions.transcript'),
        pendingInteraction: query('sessions.pendingInteraction'),
        send: mutation('sessions.send'),
        createAndSend: mutation('sessions.createAndSend'),
        cancel: mutation('sessions.cancel'),
        rewind: mutation('sessions.rewind'),
      },
    };
  },
}));

vi.mock('./CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ currentProjectId: harness.projectId }),
}));

vi.mock('./SelectedSessionProvider', async () => {
  const React = await import('react');
  const publishSelection = (sessionId: string) => {
    harness.selectCreatedSession(sessionId);
    harness.selection = { ...harness.selection, selectedSessionId: sessionId, isDraft: false };
    for (const listener of harness.selectionListeners) listener();
  };
  return {
    useSelectedSession: () => {
      const selection = React.useSyncExternalStore(
        (listener) => {
          harness.selectionListeners.add(listener);
          return () => harness.selectionListeners.delete(listener);
        },
        () => harness.selection,
        () => harness.selection,
      );
      return {
        ...selection,
        setSelectedSession: vi.fn(),
        selectCreatedSession: publishSelection,
        setDraftProfile: vi.fn(),
        prefillDraft: vi.fn(),
        clearDraft: vi.fn(),
      };
    },
  };
});

vi.mock('./useSessionMessageLiveSync', () => ({
  useSessionMessageLiveSync: () => ({
    ...harness.liveState,
    getMessageSnapshot: () => ({
      liveTail: harness.liveState.liveTail,
      pendingUser: harness.liveState.pendingUser,
    }),
  }),
}));

vi.mock('./useSessionCompact', () => ({ useSessionCompact: () => ({ compact: vi.fn() }) }));
vi.mock('./useInteractionActions', () => ({ useInteractionActions: () => ({}) }));
vi.mock('./useMarkSessionRead', () => ({ useMarkSessionRead: () => {} }));
vi.mock('@/features/media/MediaViewer', () => ({ useMediaViewer: () => ({ openMedia: vi.fn() }) }));
vi.mock('@/features/media/DocViewer', () => ({ useDocViewer: () => ({ openDoc: vi.fn() }) }));
vi.mock('./ChatHeader', () => ({ ChatHeader: () => null }));
vi.mock('./InlineThreadCardProto', () => ({ InlineThreadCardProto: () => null }));
vi.mock('./ContextUsageControl', () => ({ ContextUsageControl: () => null }));
vi.mock('./MessageStream', async () => {
  const React = await import('react');
  return {
    MessageStream: ({ rows }: { rows: Array<{ kind: string; text?: string }> }) => React.createElement(
      'message-stream',
      null,
      rows.filter((row) => row.kind === 'user').map((row, index) => React.createElement(
        'user-row', { key: `${row.text}-${index}` }, row.text,
      )),
    ),
  };
});

import { CenterChat } from './CenterChat';

const SESSION = {
  sessionId: 's1', name: 'Session', label: null, running: false, backgroundRunning: false,
  contextUsage: null, contextCompactionSupported: false, backendSessionId: null,
  profileName: 'default', numTurns: null, costUsd: null,
};

function emptyTranscript(sessionId: string) {
  return { sessionId, turns: [], pendingUserMessages: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function selection(isDraft: boolean) {
  return {
    selectedSessionId: isDraft ? '__new__' : 's1',
    pendingCreatedSession: null,
    isDraft,
    draftProfile: null,
    draftReloadToken: 0,
  };
}

function emptyLiveState(): {
  liveTail: LiveSessionMessage[];
  streaming: boolean;
  running: boolean;
  backgroundRunning: boolean;
  liveTurns: number | null;
  contextUsage: null;
  streamingText: string | null;
  pendingUser: PendingUserMessage[];
} {
  return {
    liveTail: [], streaming: false, running: false, backgroundRunning: false,
    liveTurns: null, contextUsage: null, streamingText: null, pendingUser: [],
  };
}

function publishLiveState(next: ReturnType<typeof emptyLiveState>): void {
  harness.liveState = next;
}

function mountCenterChat(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<LangProvider><CenterChat /></LangProvider>);
  });
  return renderer;
}

function typeAndSend(renderer: ReactTestRenderer, text: string): void {
  act(() => {
    renderer.root.findByProps({ 'data-composer-input': true }).props.onChange({ target: { value: text } });
  });
  act(() => {
    renderer.root.findByProps({ 'data-action': 'send' }).props.onClick();
  });
}

function renderedUsers(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType('user-row' as any).map((row) => row.children.join(''));
}

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  harness.projectId = 'atlas';
  harness.sessions = [SESSION];
  harness.transcripts = { s1: emptyTranscript('s1') };
  harness.selection = selection(false);
  harness.selectionListeners.clear();
  harness.sendMutateAsync.mockReset();
  harness.createAndSendMutateAsync.mockReset();
  harness.selectCreatedSession.mockReset();
  harness.invalidateQueries.mockReset();
  harness.liveState = emptyLiveState();
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
});

describe('mounted optimistic sender wiring', () => {
  it('renders an existing-session send before settlement and trusts pending authority before rejection', async () => {
    const gate = deferred<{ accepted: boolean }>();
    harness.sendMutateAsync.mockReturnValue(gate.promise);
    mounted = mountCenterChat();

    typeAndSend(mounted, 'accepted before HTTP failure');

    expect(harness.sendMutateAsync).toHaveBeenCalledOnce();
    expect(renderedUsers(mounted)).toEqual(['accepted before HTTP failure']);
    expect(mounted.root.findByProps({ 'data-composer-input': true }).props.value).toBe('');

    await act(async () => {
      harness.liveState = {
        ...emptyLiveState(),
        pendingUser: [{
          id: 'pin-1', text: 'accepted before HTTP failure', ts: new Date().toISOString(),
        }],
      };
      gate.reject(new Error('late HTTP failure'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderedUsers(mounted)).toEqual(['accepted before HTTP failure']);
    expect(JSON.stringify(mounted.toJSON())).not.toContain('data-send-error');
    expect(mounted.root.findByProps({ 'data-composer-input': true }).props.value).toBe('');
  });

  it('restores the mounted composer and shows failure after an unconfirmed rejection', async () => {
    const gate = deferred<{ accepted: boolean }>();
    harness.sendMutateAsync.mockReturnValue(gate.promise);
    mounted = mountCenterChat();

    typeAndSend(mounted, 'restore this send');
    expect(renderedUsers(mounted)).toEqual(['restore this send']);
    expect(mounted.root.findByProps({ 'data-composer-input': true }).props.value).toBe('');

    await act(async () => {
      gate.reject(new Error('offline'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderedUsers(mounted)).toEqual([]);
    expect(mounted.root.findByProps({ 'data-composer-input': true }).props.value).toBe('restore this send');
    expect(JSON.stringify(mounted.toJSON())).toContain('data-send-error');
    expect(JSON.stringify(mounted.toJSON())).toContain('offline');
  });

  it('keeps a create-and-send row through deferred promotion, ordinary live, and transcript authority', async () => {
    const gate = deferred<{ sessionId: string }>();
    harness.sessions = [];
    harness.selection = selection(true);
    harness.createAndSendMutateAsync.mockReturnValue(gate.promise);
    mounted = mountCenterChat();

    typeAndSend(mounted, 'new conversation');

    expect(harness.createAndSendMutateAsync).toHaveBeenCalledOnce();
    expect(renderedUsers(mounted)).toEqual(['new conversation']);

    await act(async () => {
      gate.resolve({ sessionId: 's-new' });
      await gate.promise;
      await Promise.resolve();
    });

    expect(harness.selectCreatedSession).toHaveBeenCalledWith('s-new');
    expect(renderedUsers(mounted)).toEqual(['new conversation']);

    const committedTs = new Date(Date.now() + 1000).toISOString();
    act(() => {
      publishLiveState({
        ...emptyLiveState(),
        liveTail: [{ sessionId: 's-new', role: 'user', text: 'new conversation', ts: committedTs }],
      });
      mounted?.update(<LangProvider><CenterChat /></LangProvider>);
    });
    expect(renderedUsers(mounted)).toEqual(['new conversation']);

    harness.transcripts['s-new'] = {
      sessionId: 's-new', pendingUserMessages: [],
      turns: [{
        turnIndex: 0,
        messages: [{
          type: 'user', text: 'new conversation', toolName: null, toolInput: null,
          ts: committedTs, elapsedMs: null,
        }],
      }],
    };
    act(() => {
      mounted?.update(<LangProvider><CenterChat /></LangProvider>);
    });

    expect(renderedUsers(mounted)).toEqual(['new conversation']);
  });
});
