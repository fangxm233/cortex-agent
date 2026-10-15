import { beforeEach, expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../src/core/paths.js';
import { modelsRepo } from '../src/store/models-repo.js';
import { clearChannelSelection, getChannelSelection } from '../src/domain/agents/config.js';
import { MockAdapter } from '../src/platform/testing.js';
import { createModelHandler, handleModelCmd, handleModeCmd } from '../src/orchestration/routing/commands/mode.js';

const selection = { backend: 'claude', provider: null, model: 'claude-sonnet-4-6', thinking: null, mode: 'plan' } as const;
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
  expect(result?.actions).toHaveLength(2);
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

test('mode accepts a route and reports the current route', async () => {
  const adapter = new MockAdapter();
  await handleModeCmd('model-cmd', adapter, '!mode plan');
  expect(getChannelSelection('model-cmd')?.mode).toBe('plan');
  await handleModeCmd('model-cmd', adapter, '!mode');
  expect(adapter.posted.at(-1)?.content.text).toContain('plan');
});
