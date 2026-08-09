// input:  Desktop composer, UI handlers and bilingual vocabulary
// output: local slash routing and failed-send render regressions
// pos:    Desktop composer behavior specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  send: vi.fn(),
  cancel: vi.fn(),
  setSelectedSession: vi.fn(),
  pickProfile: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { __kind?: string }) => options.__kind === 'cancel'
    ? { mutate: harness.cancel, isPending: false }
    : { mutateAsync: harness.send, isPending: false },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    sessions: {
      send: { mutationOptions: () => ({ __kind: 'send' }) },
      cancel: { mutationOptions: () => ({ __kind: 'cancel' }) },
      createAndSend: { mutationOptions: () => ({ __kind: 'create' }) },
      list: { queryFilter: () => ({}) },
    },
  }),
}));

vi.mock('./SelectedSessionProvider', () => ({
  useSelectedSession: () => ({
    selectCreatedSession: vi.fn(),
    setSelectedSession: harness.setSelectedSession,
  }),
}));

vi.mock('./SessionProfileSelector', async () => {
  const React = await import('react');
  return {
    useSessionProfileSelection: () => ({
      effectiveProfile: 'plan',
      options: [{ name: 'execute', sub: 'sonnet', active: false, backend: 'claude', disabled: false }],
      pick: harness.pickProfile,
    }),
    SessionProfileSelectorView: () => React.createElement('profile-selector'),
  };
});

vi.mock('@/features/media/MediaViewer', () => ({ useMediaViewer: () => ({ openMedia: vi.fn() }) }));
vi.mock('@/features/media/DocViewer', () => ({ useDocViewer: () => ({ openDoc: vi.fn() }) }));

import { Composer, ComposerSendFailure } from './Composer';

function mountComposer(compact: () => void): ReactTestRenderer {
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
        hasHistory
        prepareOptimistic={() => ({ clientId: 'c1', text: '', attachments: [], createdAt: 0 }) as never}
        enqueueOptimistic={() => {}}
        acceptOptimistic={() => true}
        rejectOptimistic={() => true}
        compactAction={{ onCompact: compact, pending: false, disabled: false, status: null, error: null, disabledReason: null }}
        onOpenSettings={harness.openSettings}
      />
    </LangProvider>,
  ); });
  return renderer;
}

function enterCommand(renderer: ReactTestRenderer, command: string): void {
  act(() => renderer.root.findByProps({ 'data-composer-input': true }).props.onChange({ target: { value: command } }));
  act(() => renderer.root.findByProps({ 'data-composer-input': true }).props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: vi.fn() }));
}

describe('Composer UI slash shortcuts', () => {
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

describe('ComposerSendFailure', () => {
  it('renders a visible alert that says the rejected message was restored', () => {
    const renderer = create(<LangProvider><ComposerSendFailure error="offline" /></LangProvider>);
    const alert = renderer.root.findByProps({ role: 'alert' });

    expect(alert.props['data-send-error']).toBe(true);
    expect(alert.children.join('')).toContain('Send failed · message restored: offline');
  });
});
