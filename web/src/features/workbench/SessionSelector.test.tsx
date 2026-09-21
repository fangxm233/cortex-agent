import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';

// What this pins down is the WIRE SHAPE of a pick. The menu's arithmetic lives in
// selection-menu.test.ts; here the question is only what leaves the component: `sessions.setSelection`
// always states the WHOLE selection, so a field the user did not choose goes back to following the
// profile — and a profile move restates it from scratch instead of carrying the old backend's model.

const ALL_AGENTS = [
  { name: 'main', description: 'the default environment', profile: '__active__' },
  { name: 'nimbus', description: 'a clean room', profile: '__active__' },
  { name: 'atlas', description: 'pinned to the other backend', profile: 'gpt-execute' },
];

const harness = vi.hoisted(() => ({
  draftSelection: { profileName: null as string | null, override: null as Record<string, string> | null },
  // What the HOST declares. The agent chip exists only where there is something to choose, so the
  // suite has to be able to shrink this list.
  agents: [] as Array<{ name: string; description?: string; profile: string }>,
  setDraftSelection: vi.fn(),
  setSelection: vi.fn(),
  setAgent: vi.fn(),
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
        agents: harness.agents,
      },
    };
  },
  // The two axes leave through two endpoints, so the mock has to tell them apart.
  useMutation: (options: any) => ({
    mutate: options?.__kind === 'sessions.setAgent' ? harness.setAgent : harness.setSelection,
  }),
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
      setSelection: { mutationOptions: () => ({ __kind: 'sessions.setSelection' }) },
      setAgent: { mutationOptions: () => ({ __kind: 'sessions.setAgent' }) },
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

import { AgentSelectorView, SessionSelectorView, useSessionSelection } from './SessionSelector';

interface MountProps {
  isDraft: boolean;
  currentProfile: string | null;
  hasHistory: boolean;
  currentOverride?: Record<string, string> | null;
  currentAgent?: string | null;
}

/** Both chips, off ONE hook — which is how the composer draws them: two controls, two axes, one
 *  resolved backend between them. */
function Composer(props: MountProps): JSX.Element {
  const selection = useSessionSelection({
    sessionId: 's1',
    ...props,
    currentOverride: (props.currentOverride ?? null) as never,
  });
  return (
    <>
      <AgentSelectorView selection={selection} />
      <SessionSelectorView selection={selection} />
    </>
  );
}

function mount(props: MountProps): ReactTestRenderer {
  return create(<LangProvider><Composer {...props} /></LangProvider>);
}

function open(renderer: ReactTestRenderer, chip: 'selection' | 'agent' = 'selection'): void {
  act(() => {
    renderer.root.findByProps({ 'data-chip': chip }).props.onClick({ stopPropagation: vi.fn() });
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
  const pane = row.split(':')[0];
  // The environment has a chip of its own now, and a flat list behind it — no drill.
  if (pane === 'agent') {
    open(renderer, 'agent');
    click(renderer, row);
    return;
  }
  open(renderer);
  if (pane === 'model' || pane === 'thinking' || pane === 'mode') drill(renderer, pane);
  click(renderer, row);
}

beforeEach(() => {
  harness.draftSelection = { profileName: null, override: null };
  harness.agents = ALL_AGENTS;
  harness.setDraftSelection.mockReset();
  harness.setSelection.mockReset();
  harness.setAgent.mockReset();
  harness.invalidateQueries.mockReset();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('SessionSelector', () => {

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
  });

  it('a draft may still cross backends, so nothing is held back', () => {
    const renderer = mount({ isDraft: true, currentProfile: null, hasHistory: false });
    open(renderer);
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'profile:gpt-execute' })).toHaveLength(1);
    drill(renderer, 'model');
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'model:pi:openai-codex:gpt-5.4' }))
      .toHaveLength(1);
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
  // ── the environment axis ──────────────────────────────────────────────────────────────────────
  // An agent pick goes to `sessions.setAgent` and NOWHERE else: the server keeps the environment
  // and the engine apart, and a pick that also restated the selection would undo that.

  it('sends an agent pick to sessions.setAgent, leaving the engine alone', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    pick(renderer, 'agent:nimbus');
    expect(harness.setAgent).toHaveBeenCalledWith({ sessionId: 's1', agentName: 'nimbus' });
    expect(harness.setSelection).not.toHaveBeenCalled();
  });

  it('hands the conversation back to the host default with an absent name', () => {
    const renderer = mount({
      isDraft: false, currentProfile: 'plan', hasHistory: true, currentAgent: 'nimbus',
    });
    pick(renderer, 'agent:default');
    expect(harness.setAgent).toHaveBeenCalledWith({ sessionId: 's1', agentName: undefined });
  });

  it('a session already following the default has nothing to take back', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    pick(renderer, 'agent:default');
    expect(harness.setAgent).not.toHaveBeenCalled();
  });

  it('a draft keeps its agent locally, to be created with', () => {
    const renderer = mount({ isDraft: true, currentProfile: null, hasHistory: false });
    pick(renderer, 'agent:nimbus');
    expect(harness.setDraftSelection).toHaveBeenCalledWith({ agentName: 'nimbus' });
    expect(harness.setAgent).not.toHaveBeenCalled();
  });

  it('an agent pinned to the other backend is drawn, but a live conversation cannot take it', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    pick(renderer, 'agent:atlas');
    expect(harness.setAgent).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ 'data-selection-row': 'agent:atlas' }).props['data-disabled'])
      .toBe('true');
  });

  it('a fresh conversation may still take it — there is no backend to be locked to yet', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: false });
    pick(renderer, 'agent:atlas');
    expect(harness.setAgent).toHaveBeenCalledWith({ sessionId: 's1', agentName: 'atlas' });
  });

  it('closes behind a pick — one level, so the visit is over', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    pick(renderer, 'agent:nimbus');
    expect(renderer.root.findAllByProps({ 'data-menu': 'agent' })).toHaveLength(0);
  });

  it('takes the screen from the engine menu rather than sitting on top of it', () => {
    // The two chips are neighbours; two open cards would overlap.
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    open(renderer);
    open(renderer, 'agent');
    expect(renderer.root.findAllByProps({ 'data-menu': 'selection' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-menu': 'agent' })).toHaveLength(1);

    open(renderer);
    expect(renderer.root.findAllByProps({ 'data-menu': 'agent' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-menu': 'selection' })).toHaveLength(1);
  });

  it('is not in the engine menu at all — the engine is the profile and its refinements', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    open(renderer);
    expect(renderer.root.findAllByProps({ 'data-selection-pane': 'agent' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'agent:nimbus' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-selection-row': 'agent:default' })).toHaveLength(0);
  });
});

// ── the agent chip ────────────────────────────────────────────────────────────────────────────
// It says which environment the next turn runs in, without being opened. What it SHOWS is the
// question here; what a pick sends is settled above.

describe('agent chip', () => {
  const chip = (renderer: ReactTestRenderer) => renderer.root.findAllByProps({ 'data-chip': 'agent' })[0];
  const label = (renderer: ReactTestRenderer): string => chip(renderer).findAllByType('span')
    .map((node) => node.children.filter((child) => typeof child === 'string').join(''))
    .filter(Boolean)[0];

  it('names the agent the session chose, and reads as a choice', () => {
    const renderer = mount({
      isDraft: false, currentProfile: 'plan', hasHistory: true, currentAgent: 'nimbus',
    });
    expect(label(renderer)).toBe('nimbus');
    expect(chip(renderer).props['data-agent-following-default']).toBe('false');
    expect(chip(renderer).props.title).toContain('a clean room');
  });

  it('names what a session following the host default will actually run, and says it is following', () => {
    const renderer = mount({ isDraft: false, currentProfile: 'plan', hasHistory: true });
    expect(label(renderer)).toBe('main');
    expect(chip(renderer).props['data-agent-following-default']).toBe('true');
  });

  it('is not drawn where there is nothing to choose', () => {
    harness.agents = [];
    expect(mount({ isDraft: false, currentProfile: 'plan', hasHistory: true })
      .root.findAllByProps({ 'data-chip': 'agent' })).toHaveLength(0);

    // One agent is a fact about the host, not a decision anyone gets to make.
    harness.agents = [ALL_AGENTS[0]];
    expect(mount({ isDraft: false, currentProfile: 'plan', hasHistory: true })
      .root.findAllByProps({ 'data-chip': 'agent' })).toHaveLength(0);

    harness.agents = ALL_AGENTS.slice(0, 2);
    expect(mount({ isDraft: false, currentProfile: 'plan', hasHistory: true })
      .root.findAllByProps({ 'data-chip': 'agent' })).toHaveLength(1);
  });
});
