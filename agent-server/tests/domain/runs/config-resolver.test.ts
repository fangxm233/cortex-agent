import { beforeEach, expect, test, vi } from 'vitest';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
const mocks = vi.hoisted(() => ({ channel: vi.fn(), defaults: vi.fn(), present: vi.fn(), route: vi.fn() }));
vi.mock('../../../src/domain/agents/config.js', () => ({ getChannelSelection: mocks.channel }));
vi.mock('../../../src/domain/agents/models.js', () => ({ getDefaultSelection: mocks.defaults }));
vi.mock('../../../src/store/models-repo.js', () => ({ modelsRepo: { readIfPresent: mocks.present } }));
vi.mock('../../../src/domain/runs/mode-env.js', () => ({ resolveModeEnv: mocks.route }));
import { resolveRunSelection, resolveRunBackend, resolveConfiguredDefaultRun, requestRoute } from '../../../src/domain/runs/config-resolver.js';

const defaults: EngineSelection = { backend: 'claude', provider: null, model: 'opus', mode: 'plan', thinking: 'high' };
const channel: EngineSelection = { ...defaults, model: 'sonnet', mode: 'api' };
const session: EngineSelection = { backend: 'pi', provider: 'openai', model: 'gpt', mode: 'openai', thinking: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.defaults.mockReturnValue(defaults);
  mocks.channel.mockImplementation((key) => key === 'web:a' ? channel : null);
  mocks.present.mockReturnValue({ default: defaults, favorites: [] });
});
test('unselected channels and channel-less runs use models.default', () => {
  expect(resolveRunSelection()).toBe(defaults);
  expect(resolveRunSelection({ channel: 'web:b' })).toBe(defaults);
});
test('channel selection beats default only on that channel', () => {
  expect(resolveRunSelection({ channel: 'web:a' })).toBe(channel);
  expect(resolveRunBackend({ channel: 'web:a' })).toBe('claude');
});
test('recorded session beats channel as a complete selection, including null thinking', () => {
  expect(resolveRunSelection({ channel: 'web:a', session: { selection: session } })).toBe(session);
  expect(resolveRunBackend({ session: { selection: session } })).toBe('pi');
});
test('explicit selection wins unchanged without loading any lower-priority configuration', () => {
  expect(resolveRunSelection({ selection: defaults, session: { selection: session }, channel: 'web:a' })).toBe(defaults);
  expect(mocks.defaults).not.toHaveBeenCalled();
  expect(mocks.channel).not.toHaveBeenCalled();
});
test('null selections are skipped', () => {
  expect(resolveRunSelection({ selection: null, session: { selection: null }, channel: 'web:a' })).toBe(channel);
});
test('configured default is null only before setup', () => {
  mocks.present.mockReturnValue(null);
  expect(resolveConfiguredDefaultRun()).toBeNull();
  expect(mocks.defaults).not.toHaveBeenCalled();
});
test('configured default does not use a channel selection', () => {
  expect(resolveConfiguredDefaultRun()).toBe(defaults);
});
test('invalid configuration propagates instead of inventing an engine', () => {
  mocks.defaults.mockImplementation(() => { throw new Error('invalid models'); });
  expect(() => resolveRunSelection()).toThrow('invalid models');
  expect(() => resolveConfiguredDefaultRun()).toThrow('invalid models');
});
test('route metadata respects the spawn-time trigger', () => {
  requestRoute({ context: { project: 'p', trigger: 'compact', routeTrigger: 'user' } }, session);
  expect(mocks.route).toHaveBeenCalledWith('openai', { project: 'p', trigger: 'user' });
});
