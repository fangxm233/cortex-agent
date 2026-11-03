import { beforeEach, expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { CLAUDE_ACCOUNTS_HOME, CONFIG_DIR } from '../src/core/paths.js';
import { upsertConnection } from '../src/core/connections-file.js';
import { modelsRepo } from '../src/store/models-repo.js';
import { clearChannelSelection, getChannelSelection } from '../src/domain/agents/config.js';
import { MockAdapter } from '../src/platform/testing.js';
import { createModelHandler, handleConnectionCmd, handleModelCmd } from '../src/orchestration/routing/commands/mode.js';

const selection = { backend: 'claude', provider: null, model: 'claude-sonnet-4-6', thinking: null, connection: null } as const;
beforeEach(() => {
  writeFileSync(join(CONFIG_DIR, 'models.json'), JSON.stringify({ default: selection, favorites: [
    { backend: 'claude', provider: null, model: selection.model },
    { backend: 'pi', provider: 'openai', model: 'gpt-test' },
  ] }));
  modelsRepo.invalidate();
  clearChannelSelection('model-cmd');
});

test('model listing offers model-level favorites as buttons', async () => {
  const router = { registerCommand: vi.fn(), getAdapter: vi.fn() };
  const handler = createModelHandler(router as never);
  const result = await handler('model-cmd', new MockAdapter(), '!model');
  if (!result) throw new Error('Expected favorite actions');
  expect(result.actions).toHaveLength(2);
  expect(result?.actions?.[1].actionId).toBe('cmd:model:set-1');
  expect(JSON.parse(result!.actions![1].value!).ref).toEqual({ backend: 'pi', provider: 'openai', model: 'gpt-test' });
});

test('provider/model selection is materialized and reset returns the full default', async () => {
  const adapter = new MockAdapter();
  await handleModelCmd('model-cmd', adapter, '!model openai/gpt-test');
  expect(getChannelSelection('model-cmd')).toMatchObject({ backend: 'pi', provider: 'openai', model: 'gpt-test' });
  await handleModelCmd('model-cmd', adapter, '!model reset');
  expect(getChannelSelection('model-cmd')).toEqual(selection);
});

test('!connection sets a stored connection, reports it, refuses an unknown one and resets to the default', async () => {
  upsertConnection({
    id: 'api', backend: 'claude', label: 'API', authStyle: 'x-api-key', key: 'sk-test-fake', billing: 'metered',
  });
  const adapter = new MockAdapter();
  await handleConnectionCmd('model-cmd', adapter, '!connection api');
  expect(getChannelSelection('model-cmd')?.connection).toBe('api');
  await handleConnectionCmd('model-cmd', adapter, '!connection');
  expect(adapter.posted.at(-1)?.content.text).toContain('api');
  await handleConnectionCmd('model-cmd', adapter, '!mode missing');
  expect(getChannelSelection('model-cmd')?.connection).toBe('api');
  expect(adapter.posted.at(-1)?.content.text).toContain('missing');
  await handleConnectionCmd('model-cmd', adapter, '!connection reset');
  expect(getChannelSelection('model-cmd')?.connection).toBeNull();
});

test('!connection switches to a signed-in Claude account and names it by its label', async () => {
  upsertConnection({ id: 'school', backend: 'claude', type: 'account', label: 'School Team' });
  const dir = join(CLAUDE_ACCOUNTS_HOME, 'school');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 86_400_000 } }));
  const adapter = new MockAdapter();
  await handleConnectionCmd('model-cmd', adapter, '!connection school');
  expect(getChannelSelection('model-cmd')?.connection).toBe('school');
  await handleConnectionCmd('model-cmd', adapter, '!connection');
  expect(adapter.posted.at(-1)?.content.text).toContain('school');
  expect(adapter.posted.at(-1)?.content.text).toContain('School Team');
});
