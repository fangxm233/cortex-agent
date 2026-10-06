import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { LangProvider } from '@/i18n';

// The draft → created-session hand-off, driven through the real router and the mobile outlet:
// `/m/session/new` becomes `/m/session/<id>` under the user's eyes, so whatever the screen holds for
// that first message (its optimistic row, the engine it was sent with) has to survive the route
// change — and a user who already left the draft must not be pulled back into the new session.

const harness = vi.hoisted(() => ({
  sessions: [] as any[],
  transcripts: {} as Record<string, any>,
  createAndSendMutateAsync: vi.fn(),
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
      if (options.__kind === 'config.get') return {
        data: {
          profiles: {
            defaultProfile: 'plan',
            profiles: [
              { name: 'plan', model: 'opus', backend: 'claude' },
              { name: 'execute', model: 'sonnet', backend: 'claude' },
            ],
          },
          agents: [],
        },
        isPending: false,
      };
      return { data: undefined, isPending: false };
    },
    useMutation: (options: any) => options.__kind === 'sessions.createAndSend'
      ? { mutateAsync: harness.createAndSendMutateAsync, isPending: false }
      : { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock('@/lib/trpc', () => ({
  useTRPCClient: () => ({ sessions: { transcript: { query: vi.fn() } } }),
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
        setSelection: mutation('sessions.setSelection'),
        setAgent: mutation('sessions.setAgent'),
        cancel: mutation('sessions.cancel'),
        rewind: mutation('sessions.rewind'),
        compact: mutation('sessions.compact'),
      },
      config: { get: query('config.get') },
      models: { catalog: query('models.catalog') },
      schedules: { list: query('schedules.list') },
      waitpoints: { list: query('waitpoints.list'), cancel: mutation('waitpoints.cancel') },
      commissions: { list: query('commissions.list'), get: query('commissions.get') },
    };
  },
}));

vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ currentProjectId: 'atlas', setCurrentProject: vi.fn() }),
}));

vi.mock('@/features/session/live/useSessionMessageLiveSync', () => {
  const live = {
    liveTail: [], streaming: false, running: false, backgroundRunning: false, liveTurns: null,
    contextUsage: null, todos: null, streamingText: null, pendingUser: [],
  };
  return {
    invalidateActiveSubagentTranscriptQueries: vi.fn(),
    useSessionMessageLiveSync: () => ({ ...live, getMessageSnapshot: () => live }),
  };
});
vi.mock('@/features/session/interaction/useInteractionActions', () => ({ useInteractionActions: () => ({}) }));
vi.mock('@/features/session/live/useMarkSessionRead', () => ({ useMarkSessionRead: () => {} }));
vi.mock('@/features/attachments/useAttachmentUploads', () => ({
  useAttachmentUploads: () => ({
    items: [], completed: [], hasNonDone: false,
    addFiles: vi.fn(), remove: vi.fn(), retry: vi.fn(), replaceRestored: vi.fn(), mergeRestored: vi.fn(), reset: vi.fn(),
  }),
}));
vi.mock('./MChatView', async () => {
  const React = await import('react');
  return {
    MChatView: (props: any) => React.createElement(
      'm-chat-view',
      {
        onComposerChange: props.onComposerChange,
        onSend: props.onSend,
        'data-chip': props.selectionChipLabel,
      },
      props.rows
        .filter((row: { kind: string }) => row.kind === 'user')
        .map((row: { text: string }, index: number) => React.createElement('user-row', { key: index }, row.text)),
    ),
  };
});

import { AnimatedOutlet } from '../MobileAnimatedOutlet';
import { MChatScreen } from './MChatScreen';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | null = null;

function mountAt(path: string) {
  const router = createMemoryRouter([{
    path: '/',
    element: <AnimatedOutlet />,
    children: [
      { path: '/m/sessions', element: <span /> },
      { path: '/m/session/:sessionId', element: <MChatScreen /> },
    ],
  }], { initialEntries: [path] });
  act(() => { renderer = create(<LangProvider><RouterProvider router={router} /></LangProvider>); });
  return router;
}

/** The chat on screen: the current route layer's, not an outgoing one still sliding away. */
function chat() {
  const layer = renderer!.root.find((node) => node.props['data-route-layer'] === 'current');
  return layer.findByType('m-chat-view' as any);
}

function typeAndSend(text: string): void {
  act(() => { chat().props.onComposerChange(text); });
  act(() => { chat().props.onSend(); });
}

function users(): string[] {
  return chat().findAllByType('user-row' as any).map((row) => row.children.join(''));
}

beforeEach(() => {
  harness.sessions = [];
  harness.transcripts = {};
  harness.createAndSendMutateAsync.mockReset();
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
});

describe('mobile draft becoming its session', () => {
  it('keeps the first message and the engine it was sent with across the route change', async () => {
    const gate = deferred<{ sessionId: string; acceptedAt: string }>();
    harness.createAndSendMutateAsync.mockReturnValue(gate.promise);
    const router = mountAt('/m/session/new');

    typeAndSend('/profile execute');
    typeAndSend('first message');
    expect(users()).toEqual(['first message']);

    harness.transcripts['s-new'] = { sessionId: 's-new', turns: [], pendingUserMessages: [] };
    await act(async () => {
      gate.resolve({ sessionId: 's-new', acceptedAt: new Date().toISOString() });
      await gate.promise;
    });

    expect(router.state.location.pathname).toBe('/m/session/s-new');
    // Neither the transcript nor sessions.list knows about it yet: what is on screen is the
    // screen's own state, carried over.
    expect(users()).toEqual(['first message']);
    expect(chat().props['data-chip']).toBe('sonnet');
  });

  it('leaves a user who walked away from the draft where they went', async () => {
    const gate = deferred<{ sessionId: string; acceptedAt: string }>();
    harness.createAndSendMutateAsync.mockReturnValue(gate.promise);
    const router = mountAt('/m/session/new');

    typeAndSend('sent then left');
    await act(async () => { await router.navigate('/m/sessions'); });
    await act(async () => {
      gate.resolve({ sessionId: 's-new', acceptedAt: new Date().toISOString() });
      await gate.promise;
    });

    expect(router.state.location.pathname).toBe('/m/sessions');
  });
});
