import { beforeEach, expect, test, vi } from 'vitest';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import { clearSeededConnections, seedClaudeKeyConnection, seedClaudeSubscription } from '../../_seed-connections.js';

vi.mock('@core/log.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const mocks = vi.hoisted(() => ({ channel: vi.fn(), configured: vi.fn(), route: vi.fn() }));
vi.mock('../../../src/domain/agents/config.js', () => ({ getChannelSelection: mocks.channel, getModelMemory: () => ({}) }));
vi.mock('../../../src/domain/agents/models.js', () => ({
  configuredDefault: mocks.configured, backendStartingPoint: () => null, getDefaultSelection: mocks.configured,
}));
vi.mock('../../../src/domain/connections/claude-route.js', () => ({ resolveClaudeRoute: mocks.route }));
import {
  resolveConfiguredDefaultRun, resolveRecordedSelection, resolveRunBackend, resolveRunRoute, resolveRunSelection,
} from '../../../src/domain/runs/config-resolver.js';

const defaults: EngineSelection = { backend: 'claude', provider: null, model: 'opus', connection: 'subscription', thinking: 'high' };
const channel: EngineSelection = { ...defaults, model: 'sonnet', connection: 'api' };
const session: EngineSelection = { backend: 'pi', provider: 'openai', model: 'gpt', connection: null, thinking: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.configured.mockReturnValue(defaults);
  mocks.channel.mockImplementation((key) => key === 'web:a' ? channel : null);
  clearSeededConnections();
  seedClaudeSubscription();
  seedClaudeKeyConnection('api');
});
test('unselected channels and channel-less runs use models.default', () => {
  expect(resolveRunSelection()).toEqual(defaults);
  expect(resolveRunSelection({ channel: 'web:b' })).toEqual(defaults);
});
test('channel selection beats default only on that channel', () => {
  expect(resolveRunSelection({ channel: 'web:a' })).toEqual(channel);
  expect(resolveRunBackend({ channel: 'web:a' })).toBe('claude');
});
test('recorded session beats channel as a complete selection, including null thinking', () => {
  expect(resolveRunSelection({ channel: 'web:a', session: { selection: session } })).toEqual(session);
  expect(resolveRunBackend({ session: { selection: session } })).toBe('pi');
});
test('a carried selection wins over the session and the channel', () => {
  expect(resolveRunSelection({ selection: defaults, session: { selection: session }, channel: 'web:a' })).toEqual(defaults);
});
test('null selections are skipped', () => {
  expect(resolveRunSelection({ selection: null, session: { selection: null }, channel: 'web:a' })).toEqual(channel);
});
test('a run computes the connection a selection left open; the recorded selection keeps it open', () => {
  mocks.channel.mockReturnValue({ ...channel, connection: null });
  expect(resolveRunSelection({ channel: 'web:a' }).connection).toBe('subscription');
  expect(resolveRecordedSelection({ channel: 'web:a' }).connection).toBeNull();
});
test('a removed connection falls back for the run instead of failing it', () => {
  mocks.channel.mockReturnValue({ ...channel, connection: 'removed' });
  expect(resolveRunSelection({ channel: 'web:a' }).connection).toBe('subscription');
});
test('configured default is null only before setup', () => {
  mocks.configured.mockReturnValue(null);
  expect(resolveConfiguredDefaultRun()).toBeNull();
  expect(() => resolveRunSelection()).toThrow(/set a default model/);
});
test('configured default does not use a channel selection', () => {
  expect(resolveConfiguredDefaultRun()).toEqual(defaults);
});
test('invalid configuration propagates instead of inventing an engine', () => {
  mocks.configured.mockImplementation(() => { throw new Error('invalid models'); });
  expect(() => resolveRunSelection()).toThrow('invalid models');
  expect(() => resolveConfiguredDefaultRun()).toThrow('invalid models');
});
test('a Claude run resolves the route of its own connection', () => {
  const route = { connection: 'api', sets: { ANTHROPIC_API_KEY: 'sk-fake' }, unsets: [] };
  mocks.route.mockReturnValue(route);
  expect(resolveRunRoute(channel)).toBe(route);
  expect(mocks.route).toHaveBeenCalledWith('api');
});
test('a PI run has no Claude route', () => {
  expect(resolveRunRoute(session)).toBeUndefined();
  expect(mocks.route).not.toHaveBeenCalled();
});
