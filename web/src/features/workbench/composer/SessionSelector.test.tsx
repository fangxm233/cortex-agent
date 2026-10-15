import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { ConfigAgentEntry, ConfigModels, EngineSelection, ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import type { DraftSelection } from '@/features/session/state/selected-session';
import type { SessionSelectionInput } from '@/features/session/composer/useSessionSelection';
import { LangProvider } from '@/i18n';
import { modelKey } from '@/lib/model-selection';

const harness = vi.hoisted(() => ({
  draftSelection: { selection: null } as DraftSelection,
  models: {} as ConfigModels,
  agents: [] as ConfigAgentEntry[],
  catalog: undefined as ModelCatalogSnapshot | undefined,
  setDraftSelection: vi.fn(), setSelection: vi.fn(), setAgent: vi.fn(),
  addFavorite: vi.fn(), removeFavorite: vi.fn(), fetchQuery: vi.fn(),
  toast: vi.fn(), invalidateQueries: vi.fn(), openSection: vi.fn(),
  errors: {} as Record<string, (error: Error) => void>,
}));

vi.mock('@/features/settings/useSettings', () => ({ useSettings: () => ({ openSection: harness.openSection }) }));

type MutationOptions = { __kind: string; onError: (error: Error) => void };
vi.mock('@/design/Toast', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/design/Toast')>(),
  useToastOptional: () => ({ toast: harness.toast }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { __kind: string }) => options.__kind === 'models.catalog'
    ? { data: harness.catalog, isLoading: !harness.catalog }
    : { data: { models: harness.models, agents: harness.agents } },
  useMutation: (options: MutationOptions) => {
    harness.errors[options.__kind] = options.onError;
    const mutations = {
      'sessions.setSelection': harness.setSelection, 'sessions.setAgent': harness.setAgent,
      'models.favorites.add': harness.addFavorite, 'models.favorites.remove': harness.removeFavorite,
    };
    return { mutate: mutations[options.__kind as keyof typeof mutations] };
  },
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries, fetchQuery: harness.fetchQuery }),
}));
vi.mock('@/lib/trpc', () => {
  const mutation = (__kind: string) => ({ mutationOptions: (options: object) => ({ ...options, __kind }) });
  return { useTRPC: () => ({
    config: { get: { queryOptions: () => ({ __kind: 'config.get' }), queryFilter: () => ({}) } },
    models: {
      catalog: { queryOptions: () => ({ __kind: 'models.catalog' }) },
      favorites: { add: mutation('models.favorites.add'), remove: mutation('models.favorites.remove') },
    },
    sessions: {
      setSelection: mutation('sessions.setSelection'), setAgent: mutation('sessions.setAgent'),
      list: { queryFilter: () => ({}) },
    },
  }) };
});

import { AgentSelectorView, SessionSelectorView } from './SessionSelector';
import { useSessionSelection } from '@/features/session/composer/useSessionSelection';

const current: EngineSelection = { backend: 'claude', provider: null, model: 'claude-opus-5', thinking: 'high', mode: 'plan' };
const sonnet: EngineSelection = { ...current, model: 'claude-sonnet-5', thinking: 'low', mode: 'api' };
const pi: EngineSelection = { backend: 'pi', provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'xhigh', mode: 'deepseek' };
const catalog: ModelCatalogSnapshot = {
  routes: [
    { endpoint: 'anthropic', backend: 'claude', provider: null, modes: ['plan', 'api'],
      models: [current.model, sonnet.model], source: 'builtin', modelThinking: {} },
    { endpoint: 'deepseek', backend: 'pi', provider: 'deepseek', modes: ['deepseek'],
      models: [pi.model, 'unstarred-model'], source: 'pi', modelThinking: {} },
  ],
  thinkingLevels: { claude: ['low', 'high'], pi: ['off', 'high', 'xhigh'] }, piPending: false,
};
const agents: ConfigAgentEntry[] = [{ name: 'main', description: 'Default environment' }, { name: 'research', description: 'Clean room' }];
type MountProps = Partial<SessionSelectionInput>;
const renderers: ReactTestRenderer[] = [];

function Composer(props: MountProps): JSX.Element {
  const selection = useSessionSelection({
    sessionId: 's1', currentSelection: current, hasHistory: true, isDraft: false,
    draftSelection: harness.draftSelection, setDraftSelection: harness.setDraftSelection,
    pendingCreatedSession: null, ...props,
  });
  return <><AgentSelectorView selection={selection} /><SessionSelectorView selection={selection} /></>;
}
function mount(props: MountProps = {}, trigger?: { focus: ReturnType<typeof vi.fn> }): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><Composer {...props} /></LangProvider>, {
    createNodeMock: (node) => node.props['data-chip'] === 'selection' ? trigger ?? null : null,
  }); });
  renderers.push(renderer);
  return renderer;
}
function press(node: ReactTestInstance): void {
  act(() => node.props.onClick({ stopPropagation: vi.fn() }));
}
function open(renderer: ReactTestRenderer, chip = 'selection'): void {
  press(renderer.root.findByProps({ 'data-chip': chip }));
}
function drill(renderer: ReactTestRenderer, pane: string): void {
  press(renderer.root.findByProps({ 'data-selection-pane': pane }));
}
function row(renderer: ReactTestRenderer, id: string): ReactTestInstance {
  return renderer.root.findByProps({ 'data-selection-row': id });
}
async function pick(renderer: ReactTestRenderer, id: string): Promise<void> {
  const pane = id.split(':')[0];
  open(renderer, pane === 'agent' ? 'agent' : 'selection');
  if (['model', 'thinking', 'mode'].includes(pane)) drill(renderer, pane);
  await act(async () => { row(renderer, id).props.onClick({ stopPropagation: vi.fn() }); });
}
function star(renderer: ReactTestRenderer, model: string): ReactTestInstance {
  return renderer.root.find((node) => node.type === 'button' && node.props['aria-label']?.endsWith(`: ${model}`));
}
function assertEngineWrite(selection: EngineSelection): void {
  expect(harness.setSelection.mock.calls.map(([input]) => input)).toEqual([{ sessionId: 's1', selection }]);
  expect(harness.setAgent).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.fetchQuery.mockReset();
  harness.fetchQuery.mockResolvedValue(catalog);
  harness.draftSelection = { selection: null };
  harness.agents = agents;
  harness.catalog = catalog;
  harness.models = {
    default: current,
    favorites: [current, sonnet, pi].map(({ backend, provider, model }) => ({ backend, provider, model })),
    memory: {
      [modelKey(sonnet)]: { thinking: 'low', mode: 'api' },
      [modelKey(pi)]: { thinking: 'xhigh', mode: 'deepseek' },
    },
  };
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  act(() => { renderers.splice(0).forEach((renderer) => renderer.unmount()); });
  vi.unstubAllGlobals();
});

describe('concrete engine picks', () => {
  it('renders favorites and applies remembered thinking/route before the catalog loads', async () => {
    harness.catalog = undefined;
    const renderer = mount();
    open(renderer);
    expect(row(renderer, `favorite:${modelKey(sonnet)}`).findAllByType('span').flatMap((node) => node.children)).toContain('low');
    open(renderer);
    await pick(renderer, `favorite:${modelKey(sonnet)}`);
    assertEngineWrite(sonnet);
    expect(harness.fetchQuery).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'data-menu': 'selection' })).toHaveLength(0);
  });

  it('sends a complete remembered selection for a catalog model, not a partial patch', async () => {
    const renderer = mount();
    await pick(renderer, `model:${modelKey(sonnet)}`);
    assertEngineWrite(sonnet);
    expect(renderer.root.findByProps({ 'data-menu': 'selection' }).props['data-selection-level']).toBe('root');
  });

  it('allows a draft to change backend and keeps the full pick local', async () => {
    const renderer = mount({ isDraft: true, hasHistory: true });
    await pick(renderer, `favorite:${modelKey(pi)}`);
    expect(harness.setDraftSelection.mock.calls).toEqual([[{ selection: pi }]]);
    expect(harness.setSelection).not.toHaveBeenCalled();
    expect(harness.setAgent).not.toHaveBeenCalled();
  });

  it('allows a new session to change backend without carrying old engine fields', async () => {
    const renderer = mount({ hasHistory: false });
    await pick(renderer, `model:${modelKey(pi)}`);
    assertEngineWrite(pi);
  });

  it('renders but disables cross-backend favorite and catalog rows for live sessions', async () => {
    const renderer = mount();
    open(renderer);
    expect(row(renderer, `favorite:${modelKey(pi)}`).props.disabled).toBe(true);
    press(row(renderer, `favorite:${modelKey(pi)}`));
    open(renderer);
    drill(renderer, 'model');
    expect(row(renderer, `model:${modelKey(pi)}`).props.disabled).toBe(true);
    await act(async () => press(row(renderer, `model:${modelKey(pi)}`)));
    expect(harness.setSelection).not.toHaveBeenCalled();
    expect(harness.fetchQuery).not.toHaveBeenCalled();
  });

  it('does not reapply the current model just because its memory differs', async () => {
    const renderer = mount();
    await pick(renderer, `favorite:${modelKey(current)}`);
    expect(harness.setSelection).not.toHaveBeenCalled();
    expect(harness.fetchQuery).not.toHaveBeenCalled();
  });

  it('sends explicit null thinking while preserving every other engine field', async () => {
    await pick(mount(), 'thinking:default');
    assertEngineWrite({ ...current, thinking: null });
  });

  it('sends a route change as a complete selection', async () => {
    await pick(mount(), 'mode:api');
    assertEngineWrite({ ...current, mode: 'api' });
  });
});

describe('catalog resolution before applying favorites', () => {
  it('waits for the catalog and uses its first route rather than guessing', async () => {
    harness.catalog = undefined;
    harness.models.memory = {};
    let resolve!: (value: ModelCatalogSnapshot) => void;
    harness.fetchQuery.mockReturnValue(new Promise<ModelCatalogSnapshot>((done) => { resolve = done; }));
    const renderer = mount();
    await pick(renderer, `favorite:${modelKey(sonnet)}`);
    expect(harness.fetchQuery).toHaveBeenCalledWith({ __kind: 'models.catalog' });
    expect(harness.setSelection).not.toHaveBeenCalled();
    await act(async () => resolve({ ...catalog, routes: [{ ...catalog.routes[0], modes: ['api', 'plan'] }] }));
    assertEngineWrite({ ...sonnet, thinking: null, mode: 'api' });
  });

  it('does not submit an incomplete selection if the model route remains unavailable', async () => {
    harness.catalog = undefined;
    harness.models.memory = {};
    harness.fetchQuery.mockResolvedValue({ ...catalog, routes: [] });
    await pick(mount(), `favorite:${modelKey(sonnet)}`);
    expect(harness.fetchQuery).toHaveBeenCalledOnce();
    expect(harness.setSelection).not.toHaveBeenCalled();
  });

  it('reports catalog fetch failures instead of applying a guessed route', async () => {
    harness.catalog = undefined;
    harness.models.memory = {};
    harness.fetchQuery.mockRejectedValue(new Error('catalog offline'));
    await pick(mount(), `favorite:${modelKey(sonnet)}`);
    expect(harness.setSelection).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith({ title: 'Could not change selection', description: 'catalog offline', tone: 'failed' });
  });
});

describe('model favorites and presentation', () => {
  it.each([
    [sonnet.model, true, 'removeFavorite'], ['unstarred-model', false, 'addFavorite'],
  ] as const)('toggles %s without selecting it or leaving the catalog', (model, favorite, mutation) => {
    const renderer = mount();
    open(renderer);
    drill(renderer, 'model');
    const button = star(renderer, model);
    expect(button.props['aria-pressed']).toBe(favorite);
    const stopPropagation = vi.fn();
    act(() => button.props.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    const ref = favorite ? { backend: 'claude', provider: undefined, model } : { backend: 'pi', provider: 'deepseek', model };
    expect(harness[mutation].mock.calls).toEqual([[ref]]);
    expect(harness.setSelection).not.toHaveBeenCalled();
    expect(harness.setDraftSelection).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ 'data-menu': 'selection' }).props['data-selection-level']).toBe('model');
  });

  it('has no follow or clear-override engine rows in any pane', () => {
    const renderer = mount({ currentSelection: sonnet });
    open(renderer);
    const forbiddenRows = () => renderer.root.findAll((node) =>
      typeof node.props['data-selection-row'] === 'string'
      && /:follow|selection:clear/.test(node.props['data-selection-row']));
    expect(forbiddenRows()).toHaveLength(0);
    for (const pane of ['model', 'thinking', 'mode']) {
      drill(renderer, pane);
      expect(forbiddenRows()).toHaveLength(0);
      press(renderer.root.findByProps({ 'data-selection-back': 'true' }));
    }
    expect(renderer.root.findAllByProps({ 'data-selection-pane': 'agent' })).toHaveLength(0);
  });

  it('filters catalog rows without discarding provider identity', () => {
    const renderer = mount({ hasHistory: false });
    open(renderer);
    drill(renderer, 'model');
    act(() => renderer.root.findByProps({ 'data-selection-filter': 'model' }).props.onChange({ target: { value: ' SONNET ' } }));
    expect(row(renderer, `model:${modelKey(sonnet)}`)).toBeDefined();
    expect(renderer.root.findAllByProps({ 'data-selection-row': `model:${modelKey(pi)}` })).toHaveLength(0);
  });
});

describe('independent environment and transition state', () => {
  it('can change any environment in a live session without sending an engine change', async () => {
    await pick(mount(), 'agent:research');
    expect(harness.setAgent.mock.calls.map(([input]) => input)).toEqual([{ sessionId: 's1', agentName: 'research' }]);
    expect(harness.setSelection).not.toHaveBeenCalled();
  });

  it('returns to the default environment by omitting its name on the wire', async () => {
    await pick(mount({ currentAgent: 'research' }), 'agent:default');
    expect(harness.setAgent.mock.calls.map(([input]) => input)).toEqual([{ sessionId: 's1', agentName: undefined }]);
    expect(harness.setSelection).not.toHaveBeenCalled();
  });

  it('keeps a draft environment pick local', async () => {
    await pick(mount({ isDraft: true }), 'agent:research');
    expect(harness.setDraftSelection.mock.calls).toEqual([[{ agentName: 'research' }]]);
    expect(harness.setAgent).not.toHaveBeenCalled();
    expect(harness.setSelection).not.toHaveBeenCalled();
  });

  it('uses pending engine and environment metadata while a new row is absent', async () => {
    const renderer = mount({
      sessionId: 'new', currentSelection: undefined, currentAgent: undefined,
      pendingCreatedSession: { sessionId: 'new', selection: pi, agentName: 'research' },
    });
    expect(renderer.root.findByProps({ 'data-chip': 'agent' }).props.title).toContain('research');
    expect(renderer.root.findByProps({ 'data-chip': 'selection' }).props.title).toContain(pi.model);
    await pick(renderer, 'thinking:default');
    expect(harness.setSelection.mock.calls.map(([input]) => input)).toEqual([
      { sessionId: 'new', selection: { ...pi, thinking: null } },
    ]);
  });

  it('hides an environment chooser when there is no actual choice', () => {
    for (const list of [[], agents.slice(0, 1)]) {
      harness.agents = list;
      expect(mount().root.findAllByProps({ 'data-chip': 'agent' })).toHaveLength(0);
    }
  });

  it('shows explicit versus default environments and keeps the two menus exclusive', () => {
    const renderer = mount({ currentAgent: 'research' });
    expect(renderer.root.findByProps({ 'data-chip': 'agent' }).props['data-agent-following-default']).toBe('false');
    expect(renderer.root.findByProps({ 'data-chip': 'agent' }).props.title).toContain('Clean room');
    open(renderer);
    open(renderer, 'agent');
    expect(renderer.root.findAllByProps({ 'data-menu': 'selection' })).toHaveLength(0);
    open(renderer);
    expect(renderer.root.findAllByProps({ 'data-menu': 'agent' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-menu': 'selection' })).toBeDefined();
  });
});

describe('menu navigation', () => {
  it.each(['model', 'thinking', 'mode'])('animates entering and leaving %s, not the first open', (pane) => {
    const renderer = mount();
    open(renderer);
    const content = () => renderer.root.findByProps({ className: 'selection-pane' });
    expect(content().props['data-motion']).toBeUndefined();
    drill(renderer, pane);
    expect(content().props['data-pane']).toBe(pane);
    expect(content().props['data-motion']).toBe('forward');
    press(renderer.root.findByProps({ 'data-selection-back': 'true' }));
    expect(content().props['data-pane']).toBe('root');
    expect(content().props['data-motion']).toBe('back');
  });

  it('anchors the menu beside a focusable trigger, without nesting buttons', () => {
    const renderer = mount();
    const trigger = renderer.root.findByProps({ 'data-chip': 'selection' });
    expect(trigger.type).toBe('button');
    expect(trigger.props['aria-expanded']).toBe(false);
    expect(trigger.props.className).toContain('focus-visible:outline');
    open(renderer);
    expect(trigger.props['aria-expanded']).toBe(true);
    expect(trigger.findAllByType('button')).toHaveLength(1);
    expect(renderer.root.findByProps({ 'data-menu': 'selection' }).parent).not.toBe(trigger);
  });

  it('retreats on subpane Escape and restores trigger focus only on root Escape', () => {
    const trigger = { focus: vi.fn() };
    const renderer = mount({}, trigger);
    const escape = () => act(() => { window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); });
    open(renderer);
    drill(renderer, 'model');
    escape();
    expect(renderer.root.findByProps({ 'data-menu': 'selection' }).props['data-selection-level']).toBe('root');
    expect(trigger.focus).not.toHaveBeenCalled();
    escape();
    expect(renderer.root.findAllByProps({ 'data-menu': 'selection' })).toHaveLength(0);
    expect(trigger.focus.mock.calls).toEqual([[{ preventScroll: true }]]);
    trigger.focus.mockClear();
    open(renderer);
    act(() => { window.dispatchEvent(new Event('click')); });
    expect(renderer.root.findAllByProps({ 'data-menu': 'selection' })).toHaveLength(0);
    expect(trigger.focus).not.toHaveBeenCalled();
  });
});

it.each(['sessions.setSelection', 'sessions.setAgent', 'models.favorites.add', 'models.favorites.remove'])(
  'reports %s errors through the shared toast', (kind) => {
    mount();
    act(() => harness.errors[kind](new Error('offline')));
    expect(harness.toast).toHaveBeenCalledWith({ title: 'Could not change selection', description: 'offline', tone: 'failed' });
  },
);

it('opens Models settings and closes the selection menu without changing the model', () => {
  const renderer = mount();
  open(renderer);
  press(renderer.root.findByProps({ 'data-selection-settings': true }));
  expect(harness.openSection).toHaveBeenCalledWith('models');
  expect(renderer.root.findByProps({ 'data-chip': 'selection' }).props['aria-expanded']).toBe(false);
  expect(harness.setSelection).not.toHaveBeenCalled();
  expect(harness.setDraftSelection).not.toHaveBeenCalled();
});
