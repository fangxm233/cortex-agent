// input:  Composer, mocked session and attachment state
// output: Composer material and action regression tests
// pos:    Verify composer inputs, commands and pending actions
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
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
  attachmentItems: [] as any[],
  attachmentRetry: vi.fn(),
  createPending: false,
  // Query data by key root, so a test can stock the active-commission list and the title behind
  // commissions.get while every other query stays empty — this suite's ordinary case.
  queries: {} as Record<string, unknown>,
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { __kind?: string }) => options.__kind === 'cancel'
    ? { mutate: harness.cancel, isPending: false }
    : options.__kind === 'create'
      ? { mutateAsync: harness.send, isPending: harness.createPending }
      : { mutateAsync: harness.send, isPending: false },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  // The composer's commission control reads the active-commission list; no commissions is the
  // ordinary case here, and only the commission suite below stocks a result.
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
      setCommission: { mutationOptions: () => ({ __kind: 'set-commission' }) },
      list: { queryFilter: () => ({}) },
    },
    commissions: {
      list: { queryOptions: () => ({ queryKey: ['commissions.list'] }), queryFilter: () => ({}) },
      get: { queryOptions: () => ({ queryKey: ['commissions.get'] }) },
    },
    // The commission feature switch is read from the shared config.get snapshot; undefined data
    // (the useQuery mock above) means "off", which is the default this suite renders under.
    config: { get: { queryOptions: () => ({ queryKey: ['config.get'] }) } },
  }),
}));

vi.mock('@/features/session/state/SelectedSessionProvider', async () => {
  const React = await import('react');
  // The draft's commission choice lives in the provider (a rail row or the board can open a draft
  // already armed with one), so the mock holds real state: the capsule reads back what the ＋ menu
  // wrote, exactly as it does against the real provider.
  return {
    useSelectedSession: () => {
      const [draftCommission, setDraftCommission] = React.useState<null | 'new' | string>(null);
      return {
        selectCreatedSession: vi.fn(),
        setSelectedSession: harness.setSelectedSession,
        draftCommission,
        setDraftCommission,
        startCommissionDraft: vi.fn(),
      };
    },
  };
});

vi.mock('./SessionSelector', async () => {
  const React = await import('react');
  return {
    useSessionSelection: () => ({
      open: false, setOpen: vi.fn(),
      effective: {
        profileName: 'plan', backend: 'claude', model: 'claude-opus-5', provider: null,
        thinking: 'high', modelOverridden: false, thinkingOverridden: false,
      },
      profileOptions: [{ name: 'execute', sub: 'sonnet', active: false, backend: 'claude', disabled: false }],
      modelGroups: [], thinkingOptions: [], profileModel: 'claude-opus-5', profileThinking: 'high',
      modelsReady: true,
      pickProfile: harness.pickProfile, pickModel: vi.fn(), pickThinking: vi.fn(),
    }),
    SessionSelectorView: () => React.createElement('selection-chip'),
    AgentSelectorView: () => React.createElement('agent-chip'),
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
        elapsed="1s"
        currentProfile="plan"
        currentOverride={null}
        draftSelection={{ profileName: null, override: null }}
        hasHistory
        prepareOptimistic={() => ({ clientId: 'c1', text: '', attachments: [], createdAt: 0 }) as never}
        enqueueOptimistic={() => {}}
        acceptOptimistic={() => true}
        rejectOptimistic={() => true}
        compactAction={{ onCompact: compact, pending: false, disabled: false, status: null, error: null, disabledReason: null }}
        onOpenSettings={harness.openSettings}
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

describe('Composer commission capsule', () => {
  afterEach(() => { harness.queries = {}; });

  it('names the commission a draft is joining instead of calling it unnamed', () => {
    // The draft holds the id alone; the menu's titles are gone the moment it closes, so the capsule
    // has to fetch the title back. "unnamed" belongs to a contract that has not been named yet.
    harness.queries['config.get'] = { settings: [{ key: 'commissionEnabled', value: true }] };
    harness.queries['commissions.list'] = [{ id: 'cm-1', title: 'Refactor the rail' }];
    harness.queries['commissions.get'] = { title: 'Refactor the rail' };
    const renderer = mountComposer(() => {}, { isDraft: true });

    act(() => renderer.root.findByProps({ 'data-chip': 'plus' }).props.onClick({ stopPropagation: vi.fn() }));
    act(() => renderer.root.findByProps({ 'data-plus-item': 'commission' }).props.onClick({ stopPropagation: vi.fn() }));
    act(() => renderer.root.findByProps({ 'data-commission-option': 'cm-1' }).props.onClick({ stopPropagation: vi.fn() }));

    const chip = renderer.root.findByProps({ 'data-chip': 'commission' });
    expect(chip.props['data-commission-value']).toBe('cm-1');
    expect(chip.props['aria-label']).toContain('Refactor the rail');
    act(() => renderer.unmount());
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

  it('routes all five commands locally instead of sending them', () => {
    const compact = vi.fn();
    const renderer = mountComposer(compact);

    enterCommand(renderer, '/new');
    enterCommand(renderer, '/cancel');
    enterCommand(renderer, '/compact');
    enterCommand(renderer, '/profile execute');
    enterCommand(renderer, '/settings');

    expect(harness.setSelectedSession).toHaveBeenCalledWith('__draft__');
    expect(harness.cancel).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(compact).toHaveBeenCalledOnce();
    expect(harness.pickProfile).toHaveBeenCalledWith('execute');
    expect(harness.openSettings).toHaveBeenCalledOnce();
    expect(harness.send).not.toHaveBeenCalled();
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
