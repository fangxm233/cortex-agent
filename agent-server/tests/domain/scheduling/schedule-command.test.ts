import { beforeEach, expect, test, vi } from 'vitest';
import type { PlatformAdapter } from '../../../src/platform/index.js';
import { createScheduleHandler } from '../../../src/orchestration/routing/commands/schedule.js';
import { buildScheduleTask, type ScheduleSpec } from '../../../src/domain/scheduling/schedule-spec.js';
import { getDefaultSelection, resolveModelRef, selectionForModel } from '../../../src/domain/agents/models.js';
import { DEFAULT_SELECTION, seedScheduleModels } from './selection-fixture.js';

beforeEach(seedScheduleModels);

function setup() {
  const add = vi.fn(async (spec: ScheduleSpec) => buildScheduleTask(spec, 'task1', Date.now(), spec.selection ?? getDefaultSelection()));
  const scheduler = { add, list: vi.fn(), pause: vi.fn(), resume: vi.fn(), remove: vi.fn() };
  const handler = createScheduleHandler(scheduler);
  return { add, run: (text: string) => handler('channel', {} as PlatformAdapter, text) };
}

test('schedule command resolves provider/model and validates explicit thinking', async () => {
  const { add, run } = setup();
  const result = await run('!schedule add interval 30m --model openai/gpt-test --thinking high check GPU');
  expect(add).toHaveBeenCalledTimes(1);
  expect(add.mock.calls[0][0]).toMatchObject({
    message: 'check GPU', intervalMs: 1_800_000,
    selection: { ...selectionForModel(resolveModelRef('openai/gpt-test')), thinking: 'high' },
  });
  expect(result.text).toContain('pi · gpt-test');
});

test('schedule command accepts bare model references and leaves absent selection for add to materialize', async () => {
  const { add, run } = setup();
  await run(`!schedule add daily 09:00 --model ${DEFAULT_SELECTION.model} digest`);
  expect(add.mock.calls[0][0].selection).toEqual(selectionForModel(resolveModelRef(DEFAULT_SELECTION.model)));
  await run('!schedule add once 5m remind me');
  expect(add.mock.calls[1][0]).toMatchObject({ message: 'remind me', selection: undefined });
});

test('schedule command rejects retired flags, missing model, and invalid thinking without adding', async () => {
  const { add, run } = setup();
  for (const flags of ['--profile plan digest', '--model', '--model --thinking high digest', '--thinking bogus digest']) {
    const result = await run(`!schedule add daily 09:00 ${flags}`);
    expect(result.text).toMatch(/Unknown option|Missing value|Invalid thinking/);
  }
  expect(add).not.toHaveBeenCalled();
});
