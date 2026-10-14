import type { ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  send: vi.fn(),
  cancel: vi.fn(),
  setSelectedSession: vi.fn(),
  pickProfile: vi.fn(),
  openSettings: vi.fn(),
  openUsage: vi.fn(),
  attachmentItems: [] as any[],
  attachmentRetry: vi.fn(),
  createPending: false,
  // Query data by key root; every query stays empty unless a test stocks it.
  queries: {} as Record<string, unknown>,
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { __kind?: string }) => options.__kind === 'cancel'
    ? { mutate: harness.cancel, isPending: false }
    : options.__kind === 'create'
      ? { mutateAsync: harness.send, isPending: harness.createPending }
      : { mutateAsync: harness.send, isPending: false },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: { queryKey?: unknown[] }) => ({
    data: harness.queries[String(options?.queryKey?.[0] ?? '')],
    isPending: false,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    sessions: {
      send: { mutationOptions: () => ({ __kind: 'send' }) },
      cancel: { mutationOptions: () => ({ __kind: 'cancel' }) },
      createAndSend: { mutationOptions: () => ({ __kind: 'create' }) },
      list: { queryFilter: () => ({}) },
    },
    config: { get: { queryOptions: () => ({ queryKey: ['config.get'] }) } },
    skills: { session: { queryOptions: () => ({ queryKey: ['skills.session'] }) } },
  }),
}));

vi.mock('@/features/session/state/SelectedSessionProvider', async () => {
  return {
    useSelectedSession: () => {
      return {
        selectCreatedSession: vi.fn(),
        setSelectedSession: harness.setSelectedSession,
        draftSelection: { profileName: null, override: null },
        setDraftSelection: vi.fn(),
        pendingCreatedSession: null,
        draftReloadToken: 0,
      };
    },
  };
});

vi.mock('./SessionSelector', async () => {
  const React = await import('react');
  return {
    SessionSelectorView: () => React.createElement('selection-chip'),
    AgentSelectorView: () => React.createElement('agent-chip'),
  };
});

vi.mock('@/features/session/composer/useSessionSelection', () => {
  return {
    useSessionSelection: () => ({
      open: false, setOpen: vi.fn(),
      effective: {
        profileName: 'plan', backend: 'claude', model: 'claude-opus-5', provider: null,
        thinking: 'high', modelOverridden: false, thinkingOverridden: false,
      },
      profileOptions: [{ name: 'execute', sub: 'sonnet', model: 'sonnet', thinking: null, active: false, backend: 'claude', disabled: false }],
      modelGroups: [], thinkingOptions: [], profileModel: 'claude-opus-5', profileThinking: 'high',
      modelsReady: true,
      pickProfile: harness.pickProfile, pickModel: vi.fn(), pickThinking: vi.fn(),
    }),
  };
});

vi.mock('./DraftProjectSelector', async () => {
  const React = await import('react');
  return {
    DraftProjectSelector: ({ disabled }: { disabled?: boolean }) =>
      React.createElement('draft-project-selector', { disabled }),
  };
});

vi.mock('@/features/media/MediaViewer', () => ({ useMediaViewer: () => ({ openMedia: vi.fn() }) }));
vi.mock('@/features/media/DocViewer', () => ({ useDocViewer: () => ({ openDoc: vi.fn() }) }));
vi.mock('@/features/attachments/useAttachmentUploads', () => ({
  useAttachmentUploads: () => ({
    items: harness.attachmentItems,
    completed: harness.attachmentItems.filter((item: any) => item.status === 'done' && item.meta).map((item: any) => item.meta),
    hasNonDone: harness.attachmentItems.some((item: any) => item.status !== 'done'),
    addFiles: vi.fn(), remove: vi.fn(), retry: harness.attachmentRetry, replaceRestored: vi.fn(), mergeRestored: vi.fn(), reset: vi.fn(),
  }),
}));

import { Composer } from './Composer';

function mountComposer(
  compact: () => void,
  overrides: Partial<ComponentProps<typeof Composer>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(
    <LangProvider>
      <Composer
        sessionId="s1"
        running
        turns={1}
        cost={null}
        turnClock={null}
        currentProfile="plan"
        currentOverride={null}
        hasHistory
        optimistic={{
          pendingUser: [],
          prepare: () => ({ clientId: 'c1', text: '', attachments: [], createdAt: 0 }) as never,
          enqueue: () => {},
          accept: () => true,
          reject: () => true,
        }}
        compactAction={{ onCompact: compact, pending: false, disabled: false, status: null, error: null, disabledReason: null }}
        onOpenSettings={harness.openSettings}
        onOpenUsage={harness.openUsage}
        dropTargetRef={{ current: null }}
        {...overrides}
      />
    </LangProvider>,
  ); });
  return renderer;
}

function enterCommand(renderer: ReactTestRenderer, command: string): void {
  act(() => renderer.root.findByProps({ 'data-composer-input': true }).props.onChange({ target: { value: command } }));
  act(() => renderer.root.findByProps({ 'data-composer-input': true }).props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: vi.fn() }));
}

describe('Composer material', () => {
  it('shares the filter-free card material through a transparent input', () => {
    const tree = mountComposer(vi.fn());
    const input = tree.root.findByProps({ 'data-composer-input': true });
    expect(input.props.style.background).toBe('transparent');
    expect(input.props.style.color).toBe('var(--proto-ink)');
    const card = tree.root.find((node) => node.props.style?.background === 'var(--material-card-bg)');
    expect(card.props.style.backdropFilter).toBeUndefined();
    expect(card.props.style.boxShadow).toContain('var(--material-card-shadow)');
    act(() => tree.unmount());
  });
});

describe('Composer draft project selector', () => {
  it('renders only for drafts and locks while create-and-send is pending', () => {
    const live = mountComposer(() => {});
    expect(live.root.findAllByType('draft-project-selector' as any)).toHaveLength(0);
    act(() => live.unmount());

    harness.createPending = true;
    const draft = mountComposer(() => {}, { isDraft: true });
    expect(draft.root.findByType('draft-project-selector' as any).props.disabled).toBe(true);
    harness.createPending = false;
    act(() => draft.unmount());
  });
});

describe('Composer UI slash shortcuts', () => {
  it.each(['/unknown hello', '/profile missing', '/new extra'])('explains blocked input %s and keeps the draft', (text) => {
    const renderer = mountComposer(() => {});
    enterCommand(renderer, text);
    expect(renderer.root.findByProps({ 'data-slash-error': true }).props.children).toMatch(/not sent|未发送/i);
    expect(renderer.root.findByProps({ 'data-composer-input': true }).props.value).toBe(text);
    expect(harness.send).not.toHaveBeenCalled();
    act(() => renderer.root.findByProps({ 'data-composer-input': true }).props.onChange({ target: { value: 'ordinary message' } }));
    expect(renderer.root.findAllByProps({ 'data-slash-error': true })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('shows feedback when Send is clicked for an unavailable command', () => {
    const renderer = mountComposer(() => {}, { running: false });
    act(() => renderer.root.findByProps({ 'data-composer-input': true }).props.onChange({ target: { value: '/cancel' } }));
    act(() => renderer.root.findByProps({ 'data-action': 'send' }).props.onClick());
    expect(renderer.root.findByProps({ 'data-slash-error': true }).props.children).toMatch(/unavailable|不可用/i);
    expect(renderer.root.findByProps({ 'data-composer-input': true }).props.value).toBe('/cancel');
    act(() => renderer.unmount());
  });

  it('routes every local command locally instead of sending them', () => {
    const compact = vi.fn();
    const renderer = mountComposer(compact);

    enterCommand(renderer, '/new');
    enterCommand(renderer, '/cancel');
    enterCommand(renderer, '/compact');
    enterCommand(renderer, '/profile execute');
    enterCommand(renderer, '/settings');
    enterCommand(renderer, '/usage');

    expect(harness.setSelectedSession).toHaveBeenCalledWith('__draft__');
    expect(harness.cancel).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(compact).toHaveBeenCalledOnce();
    expect(harness.pickProfile).toHaveBeenCalledWith('execute');
    expect(harness.openSettings).toHaveBeenCalledOnce();
    expect(harness.openUsage).toHaveBeenCalledOnce();
    expect(harness.send).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('Composer slash palette keyboard', () => {
  afterEach(() => { harness.queries = {}; harness.send.mockReset(); });

  const key = (renderer: ReactTestRenderer, name: string): void => {
    act(() => renderer.root.findByProps({ 'data-composer-input': true }).props.onKeyDown({ key: name, shiftKey: false, preventDefault: vi.fn() }));
  };
  const type = (renderer: ReactTestRenderer, value: string): void => {
    act(() => renderer.root.findByProps({ 'data-composer-input': true }).props.onChange({ target: { value } }));
  };
  const active = (renderer: ReactTestRenderer): string =>
    renderer.root.findByProps({ 'data-slash-active': true }).props['data-slash-command'];

  it('moves the highlight with the arrow keys and runs the highlighted command on Enter', () => {
    const renderer = mountComposer(() => {});
    type(renderer, '/');
    expect(active(renderer)).toBe('/new');
    key(renderer, 'ArrowDown');
    key(renderer, 'ArrowDown');
    key(renderer, 'ArrowDown');
    key(renderer, 'ArrowDown');
    expect(active(renderer)).toBe('/settings');
    key(renderer, 'ArrowDown');
    key(renderer, 'ArrowDown');
    expect(active(renderer)).toBe('/new');
    key(renderer, 'ArrowUp');
    expect(active(renderer)).toBe('/usage');
    key(renderer, 'Enter');
    expect(harness.openUsage).toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('lists the session skills, puts a picked one in, and sends it on the next Enter', () => {
    harness.queries['skills.session'] = [
      { plugin: 'cortex-coder', namespace: 'cortex-coder', name: 'develop', description: 'Implement a change' },
    ];
    harness.send.mockResolvedValue({ accepted: true, acceptedAt: 'now' });
    const renderer = mountComposer(() => {});
    type(renderer, '/dev');
    expect(active(renderer)).toBe('/cortex-coder:develop');
    key(renderer, 'Tab');
    expect(renderer.root.findByProps({ 'data-composer-input': true }).props.value).toBe('/cortex-coder:develop ');
    type(renderer, '/cortex-coder:develop fix the rail');
    key(renderer, 'Enter');
    expect(harness.send).toHaveBeenCalledWith({ sessionId: 's1', text: '/cortex-coder:develop fix the rail' });
    act(() => renderer.unmount());
  });
});

describe('Composer attachment send gate', () => {
  it('blocks text when done metadata is mixed with an upload error', () => {
    harness.attachmentItems = [
      { id: 'done', status: 'done', progress: 100, meta: { name: 'ok', path: 'ok', size: 1, mimeType: 'text/plain', type: 'file' } },
      { id: 'error', status: 'error', progress: 0, file: new File(['x'], 'bad') },
    ];
    const renderer = mountComposer(() => {});
    act(() => renderer.root.findByProps({ 'data-composer-input': true }).props.onChange({ target: { value: 'send me' } }));

    expect(renderer.root.findByProps({ 'data-action': 'send' }).props.disabled).toBe(true);
    const retry = renderer.root.findAll((node) => node.props.role === 'button' && node.children.join('') === 'Failed')[0];
    act(() => retry.props.onClick({ stopPropagation: vi.fn() }));
    expect(harness.attachmentRetry).toHaveBeenCalledWith('error');
    act(() => renderer.unmount());
    harness.attachmentItems = [];
    harness.attachmentRetry.mockReset();
  });
});


describe('Composer command browsing', () => {
  it.each(['unfinished draft', '   ', ''])('preserves existing text when Commands opens (%j)', (text) => {
    const tree = mountComposer(vi.fn());
    act(() => tree.root.findByProps({ 'data-composer-input': true }).props.onChange({ target: { value: text } }));
    const actions = tree.root.find((node) => typeof node.props.onCommands === 'function');
    act(() => actions.props.onCommands());
    expect(tree.root.findByProps({ 'data-composer-input': true }).props.value).toBe(text || '/');
    expect(tree.root.findAll((node) => Array.isArray(node.props.suggestions) && node.props.suggestions.length > 0).length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });
});
