// input:  mounted MChatScreen, deferred mutations, captured live and route state
// output: mobile optimistic-send display, promotion, and rejection restore specs
// pos:    Mounted mobile optimistic sender integration specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import type { LiveSessionMessage, PendingUserMessage } from '@/features/workbench/transcript-vm';

const harness = vi.hoisted(() => ({
  projectId: 'atlas',
  routeParam: 's1' as string,
  sessions: [] as any[],
  transcripts: {} as Record<string, any>,
  sendMutateAsync: vi.fn(),
  createAndSendMutateAsync: vi.fn(),
  sendPending: false,
  createAndSendPending: false,
  navigate: vi.fn(),
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
        return { data: sessionId ? harness.transcripts[sessionId] : undefined, isPending: false };
      }
      return { data: undefined, isPending: false };
    },
    useMutation: (options: any) => {
      if (options.__kind === 'sessions.send') {
        return { mutateAsync: harness.sendMutateAsync, isPending: harness.sendPending };
      }
      if (options.__kind === 'sessions.createAndSend') {
        return { mutateAsync: harness.createAndSendMutateAsync, isPending: harness.createAndSendPending };
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
    const mutation = (kind: string) => ({ mutationOptions: () => ({ __kind: kind }) });
    return {
      sessions: {
        list: query('sessions.list'),
        transcript: query('sessions.transcript'),
        send: mutation('sessions.send'),
        createAndSend: mutation('sessions.createAndSend'),
        setProfile: mutation('sessions.setProfile'),
        cancel: mutation('sessions.cancel'),
        rewind: mutation('sessions.rewind'),
      },
      config: { get: query('config.get') },
      threads: { list: query('threads.list'), get: query('threads.get') },
      schedules: { list: query('schedules.list') },
    };
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => harness.navigate,
  useParams: () => ({ sessionId: harness.routeParam }),
  useLocation: () => ({ pathname: `/m/session/${harness.routeParam}`, state: null }),
}));

vi.mock('@/mobile/current-project', () => ({
  useMobileProject: () => ({ currentProjectId: harness.projectId }),
}));

vi.mock('@/features/workbench/useSessionMessageLiveSync', () => ({
  useSessionMessageLiveSync: () => ({
    ...harness.liveState,
    getMessageSnapshot: () => ({
      liveTail: harness.liveState.liveTail,
      pendingUser: harness.liveState.pendingUser,
    }),
  }),
}));

vi.mock('@/features/workbench/useSessionCompact', () => ({ useSessionCompact: () => ({ compact: vi.fn() }) }));
vi.mock('@/features/workbench/useInteractionActions', () => ({ useInteractionActions: () => ({}) }));
vi.mock('@/features/workbench/useMarkSessionRead', () => ({ useMarkSessionRead: () => {} }));
vi.mock('@/features/thread/useThreadGetLiveSync', () => ({ useThreadGetLiveSync: () => {} }));
vi.mock('./MChatView', async () => {
  const React = await import('react');
  return {
    MChatView: (props: any) => React.createElement(
      'm-chat-view',
      {
        'data-composer-value': props.composerValue,
        'data-system-lines': JSON.stringify(props.systemLines ?? []),
        onComposerChange: props.onComposerChange,
        onSend: props.onSend,
      },
      props.rows
        .filter((row: { kind: string }) => row.kind === 'user')
        .map((row: { text: string }, index: number) => React.createElement('user-row', { key: index }, row.text)),
    ),
  };
});

import { MChatScreen } from './MChatScreen';

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

function emptyLiveState(): {
  liveTail: LiveSessionMessage[];
  streaming: boolean;
  running: boolean;
  liveTurns: number | null;
  contextUsage: null;
  streamingText: string | null;
  pendingUser: PendingUserMessage[];
} {
  return {
    liveTail: [], streaming: false, running: false,
    liveTurns: null, contextUsage: null, streamingText: null, pendingUser: [],
  };
}

function mountChat(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><MChatScreen /></LangProvider>); });
  return renderer;
}

function view(renderer: ReactTestRenderer) {
  return renderer.root.findByType('m-chat-view' as any);
}

function typeAndSend(renderer: ReactTestRenderer, text: string): void {
  act(() => { view(renderer).props.onComposerChange(text); });
  act(() => { view(renderer).props.onSend(); });
}

function renderedUsers(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType('user-row' as any).map((row) => row.children.join(''));
}

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  harness.projectId = 'atlas';
  harness.routeParam = 's1';
  harness.sessions = [SESSION];
  harness.transcripts = { s1: emptyTranscript('s1') };
  harness.sendMutateAsync.mockReset();
  harness.createAndSendMutateAsync.mockReset();
  harness.sendPending = false;
  harness.createAndSendPending = false;
  harness.navigate.mockReset();
  harness.invalidateQueries.mockReset();
  harness.liveState = emptyLiveState();
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
});

describe('mobile optimistic sender wiring', () => {
  it('shows an existing-session send before the server settles it', () => {
    const gate = deferred<{ accepted: boolean }>();
    harness.sendMutateAsync.mockReturnValue(gate.promise);
    mounted = mountChat();

    typeAndSend(mounted, 'shown before settlement');

    expect(harness.sendMutateAsync).toHaveBeenCalledOnce();
    expect(renderedUsers(mounted)).toEqual(['shown before settlement']);
    expect(view(mounted).props['data-composer-value']).toBe('');
  });

  it('hands the row over to the transcript without doubling it', async () => {
    const gate = deferred<{ accepted: boolean }>();
    harness.sendMutateAsync.mockReturnValue(gate.promise);
    mounted = mountChat();

    typeAndSend(mounted, 'handed over');
    expect(renderedUsers(mounted)).toEqual(['handed over']);

    await act(async () => {
      gate.resolve({ accepted: true });
      await gate.promise;
    });

    const committedTs = new Date(Date.now() + 1000).toISOString();
    harness.transcripts.s1 = {
      sessionId: 's1', pendingUserMessages: [],
      turns: [{
        turnIndex: 0,
        messages: [{
          type: 'user', text: 'handed over', toolName: null, toolInput: null,
          ts: committedTs, elapsedMs: null,
        }],
      }],
    };
    act(() => { mounted?.update(<LangProvider><MChatScreen /></LangProvider>); });

    expect(renderedUsers(mounted)).toEqual(['handed over']);
  });

  it('keeps a draft send visible across promotion into the created session', async () => {
    const gate = deferred<{ sessionId: string }>();
    harness.routeParam = 'new';
    harness.sessions = [];
    harness.createAndSendMutateAsync.mockReturnValue(gate.promise);
    mounted = mountChat();

    typeAndSend(mounted, 'new conversation');
    expect(harness.createAndSendMutateAsync).toHaveBeenCalledOnce();
    expect(renderedUsers(mounted)).toEqual(['new conversation']);

    harness.transcripts['s-new'] = emptyTranscript('s-new');
    await act(async () => {
      gate.resolve({ sessionId: 's-new' });
      await gate.promise;
    });
    // The route follows the created session; the row must survive the scope change.
    expect(harness.navigate).toHaveBeenCalledWith('/m/session/s-new', { replace: true });
    harness.routeParam = 's-new';
    act(() => { mounted?.update(<LangProvider><MChatScreen /></LangProvider>); });

    expect(renderedUsers(mounted)).toEqual(['new conversation']);
  });

  it('restores the composer and reports the failure when a send is rejected', async () => {
    const gate = deferred<{ accepted: boolean }>();
    harness.sendMutateAsync.mockReturnValue(gate.promise);
    mounted = mountChat();

    typeAndSend(mounted, 'restore this send');
    expect(renderedUsers(mounted)).toEqual(['restore this send']);

    await act(async () => {
      gate.reject(new Error('offline'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderedUsers(mounted)).toEqual([]);
    expect(view(mounted).props['data-composer-value']).toBe('restore this send');
    expect(view(mounted).props['data-system-lines']).toContain('offline');
  });

  it('trusts pending authority over a late rejection', async () => {
    const gate = deferred<{ accepted: boolean }>();
    harness.sendMutateAsync.mockReturnValue(gate.promise);
    mounted = mountChat();

    typeAndSend(mounted, 'accepted before HTTP failure');

    await act(async () => {
      harness.liveState = {
        ...emptyLiveState(),
        pendingUser: [{ id: 'pin-1', text: 'accepted before HTTP failure', ts: new Date().toISOString() }],
      };
      gate.reject(new Error('late HTTP failure'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderedUsers(mounted)).toEqual(['accepted before HTTP failure']);
    expect(view(mounted).props['data-composer-value']).toBe('');
    expect(view(mounted).props['data-system-lines']).not.toContain('late HTTP failure');
  });
});
