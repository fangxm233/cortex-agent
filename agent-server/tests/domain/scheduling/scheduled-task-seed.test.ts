import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_SELECTION, seedScheduleModels } from './selection-fixture.js';
import { fireScheduledTask } from '../../../src/domain/scheduling/jobs/scheduled-task.js';
import { ctx } from '../../../src/domain/scheduling/job-registry.js';
import { createDirectSession } from '../../../src/domain/sessions/session-lifecycle.js';
import { setSessionAsync } from '../../../src/domain/sessions/session.js';
import { applyChannelSelection } from '../../../src/domain/agents/model-selection.js';
import { getSelectionDefault, setSelectionDefault } from '../../../src/domain/agents/config.js';
import { sessionStore } from '../../../src/store/session-registry-repo.js';
import { conversationLedger } from '../../../src/store/conversation-ledger-repo.js';

vi.mock('../../../src/domain/executions/registry.js', () => ({ getRunningExecutions: () => [] }));

afterEach(() => {
  ctx.deliverScheduledTurn = null;
  ctx.notify = null;
});

test('scheduled session creation preserves the Web next-conversation model and agent seed', async () => {
  seedScheduleModels();
  const seed = { ...DEFAULT_SELECTION, model: 'my-next-model', agentName: 'creative' };
  setSelectionDefault(seed);
  const selection = { ...DEFAULT_SELECTION, model: 'scheduled-model' };
  const deliver = vi.fn(async () => {});
  const notify = vi.fn(async () => {});
  ctx.deliverScheduledTurn = deliver;
  ctx.notify = notify;
  const createSession = vi.fn((opts: Parameters<typeof createDirectSession>[1]) => createDirectSession({
    sessionStore,
    setChannelSession: setSessionAsync,
    initConversation: async (channel, fields) => { await conversationLedger.initConversation(channel, fields); },
    resolveBackend: () => 'claude',
  }, opts));

  await fireScheduledTask({ message: 'Summarize papers', projectId: 'general', scheduleTaskId: 'seed-regression', selection }, {
    createSession, applySelection: applyChannelSelection, newSessionId: () => 'scheduled-seed',
  });

  expect(notify).not.toHaveBeenCalled();
  expect(deliver).toHaveBeenCalledWith({ channel: 'web:scheduled-seed', text: 'Summarize papers' });
  expect(await sessionStore.getById('scheduled-seed')).toMatchObject({ selection, backend: 'claude' });
  expect(getSelectionDefault()).toEqual(seed);
  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ selection, seedDefault: false }));
});
