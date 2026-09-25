import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import type { LiveSessionMessage, PendingUserMessage } from '@/features/session/transcript/transcript-vm';

const ALL_AGENTS = [
  { name: 'main', description: 'the default environment', profile: '__active__' },
  { name: 'nimbus', description: 'a clean room', profile: '__active__' },
];

const harness = vi.hoisted(() => ({
  projectId: 'atlas',
  routeParam: 's1' as string,
  // What the HOST declares: the environment capsule exists only where there is a choice.
  agents: [] as Array<{ name: string; description?: string; profile: string }>,
  sessions: [] as any[],
  transcripts: {} as Record<string, any>,
  sendMutateAsync: vi.fn(),
  createAndSendMutateAsync: vi.fn(),
  cancelMutate: vi.fn(),
  setSelectionMutate: vi.fn(),
  setAgentMutate: vi.fn(),
  compact: vi.fn(),
  sendPending: false,
  createAndSendPending: false,
  navigate: vi.fn(),
  invalidateQueries: vi.fn(),
  liveState: {} as any,
  liveSyncArgs: null as any[] | null,
  attachmentItems: [] as any[],
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
              { name: 'plan', model: 'opus', backend: 'claude', thinking: 'high' },
              { name: 'execute', model: 'sonnet', backend: 'claude' },
              { name: 'ds', model: 'glm-5', backend: 'pi', provider: 'zai' },
            ],
          },
          agents: harness.agents,
        },
        isPending: false,
      };
      if (options.__kind === 'models.catalog') return {
        data: {
          routes: [
            {
              endpoint: 'anthropic', backend: 'claude', provider: null, modes: ['plan', 'api'],
              models: ['opus', 'sonnet'], source: 'builtin', modelThinking: {},
            },
            {
              endpoint: 'zai', backend: 'pi', provider: 'zai', modes: ['zai'],
              models: ['glm-5'], source: 'pi', modelThinking: {},
            },
          ],
          thinkingLevels: { claude: ['low', 'high'], pi: ['off', 'high'] },
          piPending: false,
        },
        isPending: false,
      };
      return { data: undefined, isPending: false };
    },
    useMutation: (options: any) => {
      if (options.__kind === 'sessions.send') {
        return { mutateAsync: harness.sendMutateAsync, isPending: harness.sendPending };
      }
      if (options.__kind === 'sessions.createAndSend') {
        return { mutateAsync: harness.createAndSendMutateAsync, isPending: harness.createAndSendPending };
      }
      if (options.__kind === 'sessions.cancel') return { mutate: harness.cancelMutate, isPending: false };
      if (options.__kind === 'sessions.setSelection') return { mutate: harness.setSelectionMutate, isPending: false };
      if (options.__kind === 'sessions.setAgent') return { mutate: harness.setAgentMutate, isPending: false };
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
        setSelection: mutation('sessions.setSelection'),
        setAgent: mutation('sessions.setAgent'),
        cancel: mutation('sessions.cancel'),
        rewind: mutation('sessions.rewind'),
      },
      config: { get: query('config.get') },
      models: { catalog: query('models.catalog') },
      threads: { list: query('threads.list'), get: query('threads.get') },
      schedules: { list: query('schedules.list') },
      // The composer's WaitRail asks what this session is waiting on.
      waitpoints: { list: query('waitpoints.list'), cancel: mutation('waitpoints.cancel') },
      commissions: { list: query('commissions.list'), get: query('commissions.get') },
    };
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => harness.navigate,
  useParams: () => ({ sessionId: harness.routeParam }),
  useLocation: () => ({ pathname: `/m/session/${harness.routeParam}`, state: null }),
}));

vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ currentProjectId: harness.projectId }),
}));

vi.mock('@/features/session/live/useSessionMessageLiveSync', () => ({
  useSessionMessageLiveSync: (...args: any[]) => {
    harness.liveSyncArgs = args;
    return {
      ...harness.liveState,
      getMessageSnapshot: () => ({
        liveTail: harness.liveState.liveTail,
        pendingUser: harness.liveState.pendingUser,
      }),
    };
  },
}));

vi.mock('@/features/session/live/useSessionCompact', () => ({
  useSessionCompact: () => ({
    onCompact: harness.compact,
    pending: false,
    disabled: false,
    status: null,
    error: null,
    disabledReason: null,
  }),
}));
vi.mock('@/features/session/interaction/useInteractionActions', () => ({ useInteractionActions: () => ({}) }));
vi.mock('@/features/session/live/useMarkSessionRead', () => ({ useMarkSessionRead: () => {} }));
vi.mock('@/features/thread/useThreadGetLiveSync', () => ({ useThreadGetLiveSync: () => {} }));
vi.mock('@/features/attachments/useAttachmentUploads', () => ({
  useAttachmentUploads: () => ({
    items: harness.attachmentItems,
    completed: harness.attachmentItems.filter((item: any) => item.status === 'done' && item.meta).map((item: any) => item.meta),
    hasNonDone: harness.attachmentItems.some((item: any) => item.status !== 'done'),
    addFiles: vi.fn(), remove: vi.fn(), retry: vi.fn(), replaceRestored: vi.fn(), mergeRestored: vi.fn(), reset: vi.fn(),
  }),
}));
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
        onSlashPick: props.onSlashPick,
        slashSuggestions: props.slashSuggestions,
        'data-todo-count': props.todos?.total ?? 0,
        'data-status-text': props.status.text,
        'data-status-running': props.status.running,
        'data-status-tone': props.status.tone,
        'data-send-enabled': props.sendEnabled,
        selectionChipLabel: props.selectionChipLabel,
        selectionChipSub: props.selectionChipSub,
        onOpenSelection: props.onOpenSelection,
        selectionSheet: props.selectionSheet,
        agentChip: props.agentChip,
        onOpenAgent: props.onOpenAgent,
        agentSheet: props.agentSheet,
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
  profileName: 'plan', numTurns: null, costUsd: null,
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
  harness.agents = ALL_AGENTS;
  harness.sessions = [SESSION];
  harness.transcripts = { s1: emptyTranscript('s1') };
  harness.sendMutateAsync.mockReset();
  harness.createAndSendMutateAsync.mockReset();
  harness.cancelMutate.mockReset();
  harness.setSelectionMutate.mockReset();
  harness.setAgentMutate.mockReset();
  harness.compact.mockReset();
  harness.sendPending = false;
  harness.createAndSendPending = false;
  harness.navigate.mockReset();
  harness.invalidateQueries.mockReset();
  harness.liveState = emptyLiveState();
  harness.liveSyncArgs = null;
  harness.attachmentItems = [];
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
});

describe('mobile chat run status priority', () => {
  it('uses the live backgroundRunning fact for the running status', () => {
    harness.sessions = [{
      ...SESSION,
      running: true,
      backgroundRunning: true,
      browser: { device: 'desk' },
      numTurns: 2,
    }];
    harness.liveState = {
      ...emptyLiveState(), running: true, backgroundRunning: true, liveTurns: 2,
    };

    mounted = mountChat();

    expect(view(mounted).props['data-status-running']).toBe(true);
  });

  it('keeps a pending interaction ahead of browser and background status', () => {
    harness.sessions = [{
      ...SESSION,
      running: true,
      backgroundRunning: true,
      browser: { device: 'desk' },
      numTurns: 1,
    }];
    harness.liveState = {
      ...emptyLiveState(), running: true, backgroundRunning: true, liveTurns: 1,
    };
    harness.transcripts.s1 = {
      sessionId: 's1',
      pendingUserMessages: [],
      turns: [{
        turnIndex: 0,
        messages: [{
          type: 'interaction', text: 'Plan', toolName: null, toolInput: null,
          ts: '2026-08-27T00:00:00.000Z', elapsedMs: null, subtype: 'plan-pending',
          interaction: {
            id: 'plan-1', kind: 'plan-approval', status: 'pending',
            payload: { planContent: '# Plan', planFilePath: null },
          },
        }],
      }],
    };

    mounted = mountChat();

    expect(view(mounted).props['data-status-tone']).toBe('waiting');
    expect(view(mounted).props['data-status-running']).toBe(false);
  });
});

describe('mobile Todo state', () => {
  it('hydrates live sync from the selected session and forwards the resolved snapshot', () => {
    const todos = {
      items: [{ content: 'Inspect state', activeForm: 'Inspecting state', status: 'in_progress' }],
      total: 1,
      completed: 0,
      activeLabel: 'Inspecting state',
      updatedAt: 1,
    };
    harness.sessions = [{ ...SESSION, todos }];
    harness.liveState = { ...emptyLiveState(), todos };

    mounted = mountChat();

    expect(harness.liveSyncArgs?.[3].todos).toBe(todos);
    expect(view(mounted).props['data-todo-count']).toBe(1);
  });
});

describe('mobile attachment send gate', () => {
  it('blocks text while a done attachment is mixed with an error', () => {
    harness.attachmentItems = [
      { id: 'done', status: 'done', progress: 100, meta: { name: 'ok', path: 'ok', size: 1, mimeType: 'text/plain', type: 'file' } },
      { id: 'error', status: 'error', progress: 0, file: new File(['x'], 'bad') },
    ];
    mounted = mountChat();
    act(() => { view(mounted!).props.onComposerChange('send me'); });

    expect(view(mounted).props['data-send-enabled']).toBe(false);
  });
});

describe('mobile UI slash shortcuts', () => {
  it.each(['/unknown hello', '/tmp/file', '/pro', '/profile', '/profile missing', '/cancel'])('explains blocked input %s without sending or clearing it', (text) => {
    mounted = mountChat();
    typeAndSend(mounted, text);
    expect(view(mounted).props['data-system-lines']).toMatch(/not sent|未发送/i);
    expect(view(mounted).props['data-composer-value']).toBe(text);
    expect(harness.sendMutateAsync).not.toHaveBeenCalled();
    expect(harness.createAndSendMutateAsync).not.toHaveBeenCalled();
  });

  it('opens a new-session draft without sending command text', () => {
    mounted = mountChat();
    typeAndSend(mounted, '/new');
    expect(harness.navigate).toHaveBeenCalledWith('/m/session/new');
    expect(harness.sendMutateAsync).not.toHaveBeenCalled();
  });

  it('cancels and compacts through the existing session actions', () => {
    harness.liveState = { ...emptyLiveState(), running: true };
    harness.sessions = [{ ...SESSION, contextCompactionSupported: true, backendSessionId: 'backend-1' }];
    mounted = mountChat();

    typeAndSend(mounted, '/cancel');
    expect(harness.cancelMutate).toHaveBeenCalledWith({ sessionId: 's1' });
    typeAndSend(mounted, '/compact');
    expect(harness.compact).toHaveBeenCalledOnce();
    expect(harness.sendMutateAsync).not.toHaveBeenCalled();
  });

  it('switches a live profile and opens mobile settings locally', () => {
    mounted = mountChat();

    typeAndSend(mounted, '/profile execute');
    expect(harness.setSelectionMutate.mock.calls[0][0]).toEqual({ sessionId: 's1', profileName: 'execute' });
    typeAndSend(mounted, '/settings');
    expect(harness.navigate).toHaveBeenCalledWith('/m/settings');
    expect(harness.sendMutateAsync).not.toHaveBeenCalled();
  });

  it('uses a slash-selected profile when the draft session is created', () => {
    harness.routeParam = 'new';
    harness.sessions = [];
    harness.createAndSendMutateAsync.mockReturnValue(new Promise(() => {}));
    mounted = mountChat();

    typeAndSend(mounted, '/profile execute');
    expect(harness.setSelectionMutate).not.toHaveBeenCalled();
    typeAndSend(mounted, 'first turn');

    expect(harness.createAndSendMutateAsync.mock.calls[0][0].profileName).toBe('execute');
  });
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
    const acceptedAt = '2026-08-01T01:00:00.000Z';
    const gate = deferred<{ accepted: boolean; acceptedAt: string }>();
    harness.sendMutateAsync.mockReturnValue(gate.promise);
    mounted = mountChat();

    typeAndSend(mounted, 'handed over');
    expect(renderedUsers(mounted)).toEqual(['handed over']);

    await act(async () => {
      gate.resolve({ accepted: true, acceptedAt });
      await gate.promise;
    });

    const committedTs = '2026-08-01T01:00:01.000Z';
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

// ── the composer's engine picker (1p sheet) ─────────────────────────────────────────────────────
// The sheet's arithmetic is m-chat-vm's (buildSelectionSheet, itself the desktop menu's); what is
// pinned here is the screen's half: which selection reaches `sessions.setSelection`, and that a
// draft keeps it locally until the session exists.

function openSelection(renderer: ReactTestRenderer) {
  act(() => { view(renderer).props.onOpenSelection(); });
  return view(renderer).props.selectionSheet;
}

/** The environment has a capsule and a sheet of its own, beside the engine's. */
function openAgent(renderer: ReactTestRenderer) {
  act(() => { view(renderer).props.onOpenAgent(); });
  return view(renderer).props.agentSheet;
}

function tapAgent(renderer: ReactTestRenderer, rowId: string): void {
  const sheet = openAgent(renderer);
  const row = sheet.rows.find((entry: any) => entry.id === rowId);
  if (!row) throw new Error(`no such agent row: ${rowId}`);
  act(() => { sheet.onPick(row); });
}

/** The sheet's own navigation is MChatSheets' business; from the screen's side a tap is just the row
 *  it hands back, wherever that row was drawn. */
function tap(renderer: ReactTestRenderer, rowId: string): void {
  const sheet = openSelection(renderer);
  const row = sheet.vm.sections.flatMap((section: any) => section.rows).find((r: any) => r.id === rowId);
  if (!row) throw new Error(`no such row: ${rowId} in ${JSON.stringify(sheet.vm.sections.flatMap((s: any) => s.rows.map((r: any) => r.id)))}`);
  act(() => { sheet.onPick(row); });
}

describe('mobile engine picker', () => {
  it('sends the whole selection, so an unstated field follows the profile again', () => {
    mounted = mountChat();
    tap(mounted, 'model:claude::sonnet');
    expect(harness.setSelectionMutate.mock.calls[0][0]).toEqual({
      sessionId: 's1', selection: { model: 'sonnet' },
    });

    // The override only reaches the screen through sessions.list, so the second pick restates from
    // the same base — what matters is that thinking is carried, not dropped silently.
    tap(mounted, 'thinking:low');
    expect(harness.setSelectionMutate.mock.calls[1][0]).toEqual({
      sessionId: 's1', selection: { thinking: 'low' },
    });
  });

  it('a live conversation is not offered the other backend at all', () => {
    harness.transcripts.s1 = {
      sessionId: 's1',
      turns: [{ messages: [{ type: 'user', text: 'earlier', createdAt: '2026-05-01T00:00:00Z' }] }],
      pendingUserMessages: [],
    };
    mounted = mountChat();
    const sheet = openSelection(mounted);
    const rows = sheet.vm.sections.flatMap((section: any) => section.rows);
    expect(rows.find((row: any) => row.id === 'model:pi:zai:glm-5')).toBeUndefined();
    expect(harness.setSelectionMutate).not.toHaveBeenCalled();
  });

  it('a draft keeps its choice locally and carries it into the created session', () => {
    harness.routeParam = 'new';
    harness.sessions = [];
    harness.createAndSendMutateAsync.mockReturnValue(new Promise(() => {}));
    mounted = mountChat();

    tap(mounted, 'model:pi:zai:glm-5');
    expect(harness.setSelectionMutate).not.toHaveBeenCalled();

    typeAndSend(mounted, 'first turn');
    expect(harness.createAndSendMutateAsync.mock.calls[0][0]).toMatchObject({
      profileName: 'ds',
      selection: { model: 'glm-5', provider: 'zai' },
    });
  });
  it('carries no environment — the agent left the engine sheet for one of its own', () => {
    mounted = mountChat();
    const sheet = openSelection(mounted);
    expect(sheet.vm.sections.map((section: any) => section.key)).not.toContain('agent');
    expect(sheet.vm.sections.flatMap((section: any) => section.rows).map((row: any) => row.id))
      .not.toContain('agent:default');
  });
});

describe('mobile environment picker', () => {
  it('an agent pick goes to sessions.setAgent, and a draft keeps it for its creation', () => {
    mounted = mountChat();
    tapAgent(mounted, 'agent:nimbus');
    expect(harness.setAgentMutate.mock.calls[0][0]).toEqual({ sessionId: 's1', agentName: 'nimbus' });
    expect(harness.setSelectionMutate).not.toHaveBeenCalled();

    harness.routeParam = 'new';
    harness.sessions = [];
    harness.createAndSendMutateAsync.mockReturnValue(new Promise(() => {}));
    mounted = mountChat();
    tapAgent(mounted, 'agent:nimbus');
    expect(harness.setAgentMutate).toHaveBeenCalledOnce();

    typeAndSend(mounted, 'first turn');
    expect(harness.createAndSendMutateAsync.mock.calls[0][0]).toMatchObject({ agentName: 'nimbus' });
  });

  it('the capsule names the fallback a session following the host default will run', () => {
    mounted = mountChat();
    expect(view(mounted).props.agentChip).toEqual({ label: 'main', followingDefault: true });
  });

  it('no capsule, and no sheet to open, where there is nothing to choose', () => {
    harness.agents = [{ name: 'main', description: 'the default environment', profile: '__active__' }];
    mounted = mountChat();
    expect(view(mounted).props.agentChip).toBeNull();
    expect(openAgent(mounted)).toBeUndefined();
  });
});
