// input:  Mocked profile config, shared selector and mutations
// output: Shared draft/live profile routing regressions
// pos:    Composer profile selector behavior specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  draftProfile: null as string | null,
  setDraftProfile: vi.fn(),
  setProfile: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      profiles: {
        defaultProfile: 'plan',
        profiles: [
          { name: 'plan', model: 'claude-opus-4-8', backend: 'claude', mode: 'plan' },
          { name: 'execute', model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
          { name: 'gpt-execute', model: 'gpt-5.4', backend: 'pi', mode: 'openai-codex' },
        ],
      },
    },
  }),
  useMutation: () => ({ mutate: harness.setProfile }),
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    config: { get: { queryOptions: () => ({}) } },
    sessions: {
      setProfile: { mutationOptions: () => ({}) },
      list: { queryFilter: () => ({}) },
    },
  }),
}));

vi.mock('./SelectedSessionProvider', () => ({
  useSelectedSession: () => ({
    draftProfile: harness.draftProfile,
    setDraftProfile: harness.setDraftProfile,
    pendingCreatedSession: null,
  }),
}));

import { SessionProfileSelector, SessionProfileSelectorView } from './SessionProfileSelector';

function mount(props: { isDraft: boolean; currentProfile: string | null; hasHistory: boolean }): ReactTestRenderer {
  return create(
    <LangProvider>
      <SessionProfileSelector sessionId="s1" {...props} />
    </LangProvider>,
  );
}

function pick(renderer: ReactTestRenderer, profile: string): void {
  act(() => {
    renderer.root.findByProps({ 'data-chip': 'profile' }).props.onClick({ stopPropagation: vi.fn() });
  });
  act(() => {
    renderer.root.findByProps({ 'data-profile': profile }).props.onClick({ stopPropagation: vi.fn() });
  });
}

beforeEach(() => {
  harness.draftProfile = null;
  harness.setDraftProfile.mockReset();
  harness.setProfile.mockReset();
  harness.invalidateQueries.mockReset();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionProfileSelector', () => {
  it('lets another composer action reuse the same selection controller', () => {
    const pickProfile = vi.fn();
    const renderer = create(
      <LangProvider>
        <SessionProfileSelectorView selection={{
          effectiveProfile: 'plan',
          options: [{ name: 'execute', sub: 'sonnet', active: false, backend: 'claude', disabled: false }],
          pick: pickProfile,
        }} />
      </LangProvider>,
    );

    act(() => renderer.root.findByProps({ 'data-chip': 'profile' }).props.onClick({ stopPropagation: vi.fn() }));
    act(() => renderer.root.findByProps({ 'data-profile': 'execute' }).props.onClick({ stopPropagation: vi.fn() }));

    expect(pickProfile).toHaveBeenCalledWith('execute');
  });

  it('opens the compact profile menu above the bottom composer row', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: false });

    act(() => {
      renderer.root.findByProps({ 'data-chip': 'profile' }).props.onClick({ stopPropagation: vi.fn() });
    });
    const menu = renderer.root.findByProps({ 'data-menu': 'profile' });
    const row = renderer.root.findByProps({ 'data-profile': 'plan' });
    const labels = row.findAllByType('span');

    expect(menu.props.style.bottom).toBe(26);
    expect(menu.props.style.top).toBeUndefined();
    expect(menu.props.style.minWidth).toBe(160);
    expect(menu.props.style.borderRadius).toBe(8);
    expect(row.props.style.padding).toBe('5px 8px');
    expect(labels[0].props.style.font).toContain('10px');
    expect(labels[1].props.style.font).toContain('9px');
  });

  it('keeps menu-option clicks from re-toggling the containing chip', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: false });
    const stopPropagation = vi.fn();

    act(() => {
      renderer.root.findByProps({ 'data-chip': 'profile' }).props.onClick({ stopPropagation: vi.fn() });
    });
    act(() => {
      renderer.root.findByProps({ 'data-profile': 'execute' }).props.onClick({ stopPropagation });
    });

    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('updates local draft state before a session exists', () => {
    const renderer = mount({ isDraft: true, currentProfile: null, hasHistory: false });

    pick(renderer, 'gpt-execute');

    expect(harness.setDraftProfile).toHaveBeenCalledWith('gpt-execute');
    expect(harness.setProfile).not.toHaveBeenCalled();
  });

  it('routes a live same-backend choice through sessions.setProfile', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });

    pick(renderer, 'execute');

    expect(harness.setProfile).toHaveBeenCalledWith({ sessionId: 's1', profileName: 'execute' });
    expect(harness.setDraftProfile).not.toHaveBeenCalled();
  });
});
