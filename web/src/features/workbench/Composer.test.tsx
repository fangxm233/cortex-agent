// input:  Desktop composer, session status facts, UI handlers, and bilingual vocabulary
// output: Slash routing, run-status priority, attachment gate, and failed-send regressions
// pos:    Desktop composer behavior specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
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
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { __kind?: string }) => options.__kind === 'cancel'
    ? { mutate: harness.cancel, isPending: false }
    : options.__kind === 'create'
      ? { mutateAsync: harness.send, isPending: harness.createPending }
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

import { Composer, ComposerSendFailure } from './Composer';

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

describe('Composer browser startup status', () => {
  it('names the Chrome device until agent progress begins', () => {
    const renderer = mountComposer(() => {}, {
      turns: null,
      sessionBrowser: { device: 'my-pc' },
      turnProgressStarted: false,
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('Starting Chrome on my-pc and connecting browser tools');

    act(() => renderer.update(
      <LangProvider>
        <Composer
          sessionId="s1"
          running
          turns={1}
          cost={null}
          elapsed="1s"
          currentProfile="plan"
          hasHistory
          sessionBrowser={{ device: 'my-pc' }}
          turnProgressStarted
          prepareOptimistic={() => ({ clientId: 'c1' }) as never}
          enqueueOptimistic={() => {}}
          acceptOptimistic={() => true}
          rejectOptimistic={() => true}
        />
      </LangProvider>,
    ));
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Starting Chrome');
    expect(JSON.stringify(renderer.toJSON())).toContain('Running');
    act(() => renderer.unmount());
  });
});

describe('Composer session run status', () => {
  it('renders an active background hold with background copy', () => {
    const renderer = mountComposer(() => {}, { backgroundRunning: true });
    const output = JSON.stringify(renderer.toJSON());

    expect(output).toContain('Background · 1s · 1 turns');
    expect(output).not.toContain('Running · 1s');
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

describe('ComposerSendFailure', () => {
  it('renders a visible alert that says the rejected message was restored', () => {
    const renderer = create(<LangProvider><ComposerSendFailure error="offline" /></LangProvider>);
    const alert = renderer.root.findByProps({ role: 'alert' });

    expect(alert.props['data-send-error']).toBe(true);
    expect(alert.children.join('')).toContain('Send failed · message restored: offline');
  });
});
