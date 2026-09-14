import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';

// What this pins down is the WIRE SHAPE of a pick. The menu's arithmetic lives in
// selection-menu.test.ts; here the question is only what leaves the component: `sessions.setSelection`
// always states the WHOLE selection, so a field the user did not choose goes back to following the
// profile — and a profile move restates it from scratch instead of carrying the old backend's model.

const harness = vi.hoisted(() => ({
  draftSelection: { profileName: null as string | null, override: null as Record<string, string> | null },
  setDraftSelection: vi.fn(),
  setSelection: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: any) => {
    if (options.__kind === 'models.catalog') {
      return {
        data: {
          routes: [
            {
              endpoint: 'anthropic', backend: 'claude', provider: null, modes: ['plan', 'api'],
              models: ['claude-opus-4-8', 'claude-sonnet-4-6'], source: 'builtin', modelThinking: {},
            },
            {
              endpoint: 'openai-codex', backend: 'pi', provider: 'openai-codex', modes: ['openai-codex'],
              models: ['gpt-5.4'], source: 'pi', modelThinking: {},
            },
          ],
          thinkingLevels: { claude: ['low', 'high'], pi: ['off', 'high'] },
          piPending: false,
        },
      };
    }
    return {
      data: {
        profiles: {
          defaultProfile: 'plan',
          profiles: [
            { name: 'plan', model: 'claude-opus-4-8', backend: 'claude', mode: 'plan', thinking: 'high' },
            { name: 'execute', model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
            { name: 'gpt-execute', model: 'gpt-5.4', backend: 'pi', mode: 'openai-codex', provider: 'openai-codex' },
          ],
        },
      },
    };
  },
  useMutation: () => ({ mutate: harness.setSelection }),
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    config: {
      get: { queryOptions: () => ({ __kind: 'config.get' }) },
    },
    models: {
      catalog: { queryOptions: () => ({ __kind: 'models.catalog' }) },
    },
    sessions: {
      setSelection: { mutationOptions: () => ({}) },
      list: { queryFilter: () => ({}) },
    },
  }),
}));

vi.mock('./SelectedSessionProvider', () => ({
  useSelectedSession: () => ({
    draftSelection: harness.draftSelection,
    setDraftSelection: harness.setDraftSelection,
    pendingCreatedSession: null,
  }),
}));

import { SessionSelector } from './SessionSelector';

function mount(props: {
  isDraft: boolean;
  currentProfile: string | null;
  hasHistory: boolean;
  currentOverride?: Record<string, string> | null;
}): ReactTestRenderer {
  return create(
    <LangProvider>
      <SessionSelector
        sessionId="s1"
        {...props}
        currentOverride={(props.currentOverride ?? null) as never}
      />
    </LangProvider>,
  );
}

function open(renderer: ReactTestRenderer): void {
  act(() => {
    renderer.root.findByProps({ 'data-chip': 'selection' }).props.onClick({ stopPropagation: vi.fn() });
  });
}

/** The menu is two levels deep now: everything but the profile list lives behind a drill row, so a
 *  model / thinking / route row is reached the way a user reaches it. */
function drill(renderer: ReactTestRenderer, pane: string): void {
  act(() => {
    renderer.root.findByProps({ 'data-selection-pane': pane }).props.onClick({ stopPropagation: vi.fn() });
  });
}

function click(renderer: ReactTestRenderer, row: string): void {
  act(() => {
    renderer.root.findByProps({ 'data-selection-row': row }).props.onClick({ stopPropagation: vi.fn() });
  });
}

function pick(renderer: ReactTestRenderer, row: string): void {
  open(renderer);
  const pane = row.split(':')[0];
  if (pane === 'model' || pane === 'thinking' || pane === 'mode') drill(renderer, pane);
  click(renderer, row);
}

beforeEach(() => {
  harness.draftSelection = { profileName: null, override: null };
  harness.setDraftSelection.mockReset();
  harness.setSelection.mockReset();
  harness.invalidateQueries.mockReset();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('SessionSelector', () => {
  it('shows the running model and level, not the profile name', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    expect(JSON.stringify(renderer.toJSON())).toContain('claude-opus-4-8');
    expect(JSON.stringify(renderer.toJSON())).toContain('high');
  });

  it('keeps menu-option clicks from re-toggling the containing chip', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: false });
    const stopPropagation = vi.fn();
    open(renderer);
    act(() => {
      renderer.root.findByProps({ 'data-selection-row': 'profile:execute' }).props.onClick({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('keeps a drill row from re-toggling the chip either', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: false });
    const stopPropagation = vi.fn();
    open(renderer);
    act(() => {
      renderer.root.findByProps({ 'data-selection-pane': 'model' }).props.onClick({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('updates local draft state before a session exists', () => {
    const renderer = mount({ isDraft: true, currentProfile: null, hasHistory: false });
    pick(renderer, 'profile:gpt-execute');
    expect(harness.setDraftSelection).toHaveBeenCalledWith({ profileName: 'gpt-execute' });
    expect(harness.setSelection).not.toHaveBeenCalled();
  });

  it('sends a profile alone — the server decides what happens to the old selection', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    pick(renderer, 'profile:execute');
    expect(harness.setSelection).toHaveBeenCalledWith({ sessionId: 's1', profileName: 'execute' });
  });

  it('a same-backend model keeps the profile and restates the rest of the selection', () => {
    const renderer = mount({
      isDraft: false, currentProfile: 'plan', hasHistory: true, currentOverride: { thinking: 'low' },
    });
    pick(renderer, 'model:claude::claude-sonnet-4-6');
    expect(harness.setSelection).toHaveBeenCalledWith({
      sessionId: 's1',
      selection: { thinking: 'low', model: 'claude-sonnet-4-6' },
    });
  });

  it('a cross-backend model names its profile and starts the selection over', () => {
    const renderer = mount({
      isDraft: false, currentProfile: 'plan', hasHistory: false, currentOverride: { thinking: 'low' },
    });
    pick(renderer, 'model:pi:openai-codex:gpt-5.4');
    expect(harness.setSelection).toHaveBeenCalledWith({
      sessionId: 's1',
      profileName: 'gpt-execute',
      selection: { model: 'gpt-5.4', provider: 'openai-codex' },
    });
  });

  it('a live conversation is not offered the other backend at all', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    open(renderer);
    // The profile that runs it is gone from the root, too.
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'profile:gpt-execute' })).toHaveLength(0);
    drill(renderer, 'model');
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'model:pi:openai-codex:gpt-5.4' }))
      .toHaveLength(0);
    // Held back, not hidden away: the pane says how many and on which backend.
    expect(JSON.stringify(renderer.toJSON())).toContain('pi');
  });

  it('a draft may still cross backends, so nothing is held back', () => {
    const renderer = mount({ isDraft: true, currentProfile: null, hasHistory: false });
    open(renderer);
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'profile:gpt-execute' })).toHaveLength(1);
    drill(renderer, 'model');
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'model:pi:openai-codex:gpt-5.4' }))
      .toHaveLength(1);
  });

  it('shows the engine in force on the root, without opening anything', () => {
    const renderer = mount({
      isDraft: false, currentProfile: 'plan', hasHistory: true, currentOverride: { thinking: 'low' },
    });
    open(renderer);
    expect(renderer.root.findAllByProps({ 'data-selection-pane': 'thinking' })).toHaveLength(1);
    // The root is showing the level itself (the pane that lists levels is not open) …
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain('low');
    // … and marks it as the session's own choice rather than the profile's.
    expect(html).toContain('•');
  });

  it('a pane pick returns to the root instead of closing, so the next facet is one click away', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    pick(renderer, 'model:claude::claude-sonnet-4-6');
    expect(renderer.root.findAllByProps({ 'data-menu': 'selection' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'profile:execute' })).toHaveLength(1);
  });

  it('Escape retreats one level before it closes the picker', () => {
    const listeners = vi.fn();
    vi.stubGlobal('window', { addEventListener: listeners, removeEventListener: vi.fn() });
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    open(renderer);
    drill(renderer, 'model');
    const escape = (): void => {
      const calls = listeners.mock.calls.filter(([type]) => type === 'keydown');
      const onKey = calls[calls.length - 1][1] as (event: { key: string }) => void;
      act(() => onKey({ key: 'Escape' }));
    };
    escape();
    // Back at the root, still open.
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'profile:execute' })).toHaveLength(1);
    escape();
    expect(renderer.root.findAllByProps({ 'data-menu': 'selection' })).toHaveLength(0);
  });

  it('a profile pick closes the menu — it replaces the whole engine', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    pick(renderer, 'profile:execute');
    expect(renderer.root.findAllByProps({ 'data-menu': 'selection' })).toHaveLength(0);
  });

  it('hands every override back at once, and offers to only when there is one', () => {
    const plain = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    open(plain);
    expect(plain.root.findAllByProps({ 'data-selection-row': 'selection:clear' })).toHaveLength(0);

    const renderer = mount({
      isDraft: false, currentProfile: 'plan', hasHistory: true,
      currentOverride: { model: 'claude-sonnet-4-6', thinking: 'low' },
    });
    pick(renderer, 'selection:clear');
    expect(harness.setSelection).toHaveBeenCalledWith({ sessionId: 's1', selection: {} });
  });

  it('"follow profile" takes back only the model, leaving the chosen level in place', () => {
    const renderer = mount({
      isDraft: false, currentProfile: 'plan', hasHistory: true,
      currentOverride: { model: 'claude-sonnet-4-6', thinking: 'low' },
    });
    pick(renderer, 'model:follow');
    expect(harness.setSelection).toHaveBeenCalledWith({
      sessionId: 's1', selection: { thinking: 'low' },
    });
  });

  it('a thinking level rides on top of the model already chosen', () => {
    const renderer = mount({
      isDraft: false, currentProfile: 'plan', hasHistory: true,
      currentOverride: { model: 'claude-sonnet-4-6' },
    });
    pick(renderer, 'thinking:low');
    expect(harness.setSelection).toHaveBeenCalledWith({
      sessionId: 's1', selection: { model: 'claude-sonnet-4-6', thinking: 'low' },
    });
  });
});
