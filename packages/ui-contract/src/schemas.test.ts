// input:  runtime shared Zod schema maps
// output: operation coverage including authentication mutations
// pos:    Runtime UI-contract schema guard
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryInputSchemas, mutateInputSchemas } from './schemas.js';

const QUERY_SCOPES = [
  'projects.list', 'sessions.list', 'sessions.transcript', 'sessions.pendingInteraction', 'threads.list',
  'threads.get', 'tasks.list', 'tasks.verification', 'schedules.list', 'executions.list', 'executions.get',
  'memory.tree', 'memory.file', 'approvals.list', 'issues.list', 'notes.list', 'cost.summary', 'config.get',
  'auth.status', 'auth.flowState', 'auth.customProviders', 'hooks.list', 'machines.list', 'skills.list', 'threadTemplates.get', 'threadTemplates.detail', 'system.daemonStatus',
  'system.rateLimitStatus',
] as const;

const MUTATE_OPS = [
  'projects.create', 'sessions.create', 'sessions.send', 'sessions.cancel', 'sessions.compact', 'sessions.setProfile',
  'sessions.createAndSend', 'sessions.markRead', 'sessions.answerQuestion', 'sessions.respondPlan',
  'sessions.rewind',
  'threads.cancel', 'executions.cancel', 'schedules.pause', 'schedules.resume',
  'schedules.remove', 'schedules.add', 'tasks.claim', 'tasks.unclaim', 'tasks.complete',
  'tasks.block', 'tasks.unblock', 'approvals.approve', 'approvals.reject', 'approvals.request',
  'issues.handle', 'issues.delete', 'notes.add', 'notes.update', 'notes.setCompleted', 'notes.delete',
  'notes.clearCompleted', 'config.set', 'hooks.create', 'hooks.update', 'hooks.setEnabled', 'hooks.remove',
  'hooks.test', 'profiles.create', 'profiles.update', 'profiles.remove',
  'threadTemplates.validate', 'threadTemplates.save', 'threadTemplates.remove',
  'auth.startLogin', 'auth.respondPrompt', 'auth.cancelFlow', 'auth.logout',
  'auth.upsertCustomProvider', 'auth.removeCustomProvider',
  'system.restart', 'system.clearRateLimit',
] as const;

test('every QueryScope has an input schema', () => {
  for (const scope of QUERY_SCOPES) {
    assert.ok(queryInputSchemas[scope], `missing query schema: ${scope}`);
  }
  assert.equal(Object.keys(queryInputSchemas).length, QUERY_SCOPES.length);
});

test('every MutateOp has an input schema', () => {
  for (const op of MUTATE_OPS) {
    assert.ok(mutateInputSchemas[op], `missing mutate schema: ${op}`);
  }
  assert.equal(Object.keys(mutateInputSchemas).length, MUTATE_OPS.length);
});

test('empty query schemas accept empty input', () => {
  assert.deepEqual(queryInputSchemas['projects.list'].parse({}), {});
  assert.deepEqual(queryInputSchemas['auth.status'].parse({}), {});
  assert.deepEqual(queryInputSchemas['system.rateLimitStatus'].parse({}), {});
});

test('auth flow schemas accept both auth types and require the prompt response value', () => {
  assert.deepEqual(
    queryInputSchemas['auth.flowState'].parse({ flowId: 'flow-1' }),
    { flowId: 'flow-1' },
  );
  for (const authType of ['api_key', 'oauth'] as const) {
    assert.deepEqual(
      mutateInputSchemas['auth.startLogin'].parse({
        backend: 'pi', provider: 'deepseek', authType,
      }),
      { backend: 'pi', provider: 'deepseek', authType },
    );
  }
  assert.deepEqual(
    mutateInputSchemas['auth.startLogin'].parse({
      backend: 'pi', provider: 'deepseek', authType: 'oauth', noticeId: 'notice-1',
    }),
    { backend: 'pi', provider: 'deepseek', authType: 'oauth', noticeId: 'notice-1' },
  );
  assert.deepEqual(
    mutateInputSchemas['auth.respondPrompt'].parse({ flowId: 'flow-1', value: 'secret' }),
    { flowId: 'flow-1', value: 'secret' },
  );
  assert.deepEqual(
    mutateInputSchemas['auth.cancelFlow'].parse({ flowId: 'flow-1' }),
    { flowId: 'flow-1' },
  );
  assert.throws(() => mutateInputSchemas['auth.respondPrompt'].parse({ flowId: 'flow-1' }));
  assert.throws(() => mutateInputSchemas['auth.startLogin'].parse({
    backend: 'pi', provider: 'deepseek', authType: 'subscription',
  }));
});

test('auth logout schema accepts only the secret-free identity tuple', () => {
  const logout = {
    backend: 'claude' as const, provider: 'anthropic', authType: 'oauth' as const,
  };
  assert.deepEqual(mutateInputSchemas['auth.logout'].parse(logout), logout);
  assert.deepEqual(
    mutateInputSchemas['auth.logout'].parse({ ...logout, credential: 'must-be-stripped' }),
    logout,
  );
  assert.throws(() => mutateInputSchemas['auth.logout'].parse({
    ...logout, authType: 'subscription',
  }));
});

test('list and detail query schemas accept valid input', () => {
  const taskInput = { projectId: 'p', status: 'open' as const, actionable: true };
  assert.equal(queryInputSchemas['tasks.list'].parse(taskInput).status, 'open');
  assert.deepEqual(
    queryInputSchemas['executions.list'].parse({ status: ['running'], limit: 5 }),
    { status: ['running'], limit: 5 },
  );
  assert.deepEqual(
    queryInputSchemas['executions.get'].parse({ executionId: 'exec_1' }),
    { executionId: 'exec_1' },
  );
  assert.deepEqual(queryInputSchemas['cost.summary'].parse({ projectId: null }), { projectId: null });
  assert.deepEqual(queryInputSchemas['threads.get'].parse({ threadId: 'thr_a' }), { threadId: 'thr_a' });
  const detail = { threadId: 'thr_a', includeArtifactContent: true };
  assert.deepEqual(queryInputSchemas['threads.get'].parse(detail), detail);
});

test('project-scoped query schemas accept valid input', () => {
  assert.deepEqual(queryInputSchemas['memory.tree'].parse({ projectId: 'p' }), { projectId: 'p' });
  const memoryFile = { projectId: 'p', path: 'STATUS.md' };
  assert.deepEqual(queryInputSchemas['memory.file'].parse(memoryFile), memoryFile);
  const transcript = { sessionId: 'sess-1' };
  assert.deepEqual(queryInputSchemas['sessions.transcript'].parse(transcript), transcript);
  assert.deepEqual(queryInputSchemas['issues.list'].parse({ projectId: 'p' }), { projectId: 'p' });
  assert.deepEqual(queryInputSchemas['notes.list'].parse({ projectId: 'p' }), { projectId: 'p' });
  assert.deepEqual(queryInputSchemas['approvals.list'].parse({}), {});
  const approval = { status: 'pending' as const };
  assert.deepEqual(queryInputSchemas['approvals.list'].parse(approval), approval);
});

test('query schemas reject invalid input', () => {
  assert.throws(() => queryInputSchemas['tasks.list'].parse({ status: 'nope' }));
  assert.throws(() => queryInputSchemas['executions.list'].parse({ limit: 'ten' }));
  assert.throws(() => queryInputSchemas['threads.get'].parse({}));
  assert.throws(() => queryInputSchemas['sessions.list'].parse({ resumable: 'yes' }));
  assert.throws(() => queryInputSchemas['memory.tree'].parse({}));
  assert.throws(() => queryInputSchemas['memory.file'].parse({ projectId: 'p' }));
  assert.throws(() => queryInputSchemas['sessions.transcript'].parse({}));
  assert.throws(() => queryInputSchemas['approvals.list'].parse({ status: 'nope' }));
  assert.throws(() => queryInputSchemas['issues.list'].parse({}));
  assert.throws(() => queryInputSchemas['notes.list'].parse({}));
});

test('mutate schemas require their mandatory fields', () => {
  assert.deepEqual(mutateInputSchemas['projects.create'].parse({ name: 'nimbus' }), { name: 'nimbus' });
  assert.throws(() => mutateInputSchemas['projects.create'].parse({}));
  // sessions.create: projectId optional (accepts empty + a project id)
  assert.deepEqual(mutateInputSchemas['sessions.create'].parse({}), {});
  assert.deepEqual(mutateInputSchemas['sessions.create'].parse({ projectId: 'nimbus' }), { projectId: 'nimbus' });
  assert.deepEqual(mutateInputSchemas['threads.cancel'].parse({ threadId: 't1' }), { threadId: 't1' });
  assert.deepEqual(
    mutateInputSchemas['tasks.claim'].parse({ projectId: 'p', taskId: 'f184' }),
    { projectId: 'p', taskId: 'f184' },
  );
  // tasks.block requires reason
  assert.throws(() => mutateInputSchemas['tasks.block'].parse({ projectId: 'p', taskId: 'f184' }));
  assert.deepEqual(
    mutateInputSchemas['tasks.block'].parse({ projectId: 'p', taskId: 'f184', reason: 'stuck' }),
    { projectId: 'p', taskId: 'f184', reason: 'stuck' },
  );
  // sessions.send requires sessionId + text; empty text is schema-legal (attachment-only sends —
  // the handler enforces "text or attachments")
  assert.deepEqual(
    mutateInputSchemas['sessions.send'].parse({ sessionId: 'sess-1', text: 'hi' }),
    { sessionId: 'sess-1', text: 'hi' },
  );
  assert.equal(mutateInputSchemas['sessions.send'].parse({ sessionId: 'sess-1', text: '' }).text, '');
  assert.throws(() => mutateInputSchemas['sessions.send'].parse({ sessionId: 'sess-1' }));
  // sessions.cancel requires sessionId
  assert.deepEqual(mutateInputSchemas['sessions.cancel'].parse({ sessionId: 'sess-1' }), { sessionId: 'sess-1' });
  assert.throws(() => mutateInputSchemas['sessions.cancel'].parse({}));
  assert.deepEqual(mutateInputSchemas['sessions.compact'].parse({ sessionId: 'sess-1' }), { sessionId: 'sess-1' });
  assert.throws(() => mutateInputSchemas['sessions.compact'].parse({}));
  // missing required id
  assert.throws(() => mutateInputSchemas['threads.cancel'].parse({}));
  assert.throws(() => mutateInputSchemas['tasks.claim'].parse({ projectId: 'p' }));
  // approvals.approve requires id; approvals.reject id + optional feedback
  assert.deepEqual(mutateInputSchemas['approvals.approve'].parse({ id: 'a1' }), { id: 'a1' });
  assert.deepEqual(
    mutateInputSchemas['approvals.reject'].parse({ id: 'a1', feedback: 'no' }),
    { id: 'a1', feedback: 'no' },
  );
  assert.throws(() => mutateInputSchemas['approvals.approve'].parse({}));
  // issues.handle / issues.delete require projectId + id
  assert.deepEqual(
    mutateInputSchemas['issues.handle'].parse({ projectId: 'p', id: 'i1' }),
    { projectId: 'p', id: 'i1' },
  );
  assert.deepEqual(
    mutateInputSchemas['issues.delete'].parse({ projectId: 'p', id: 'i1' }),
    { projectId: 'p', id: 'i1' },
  );
  assert.throws(() => mutateInputSchemas['issues.handle'].parse({ id: 'i1' }));
  assert.throws(() => mutateInputSchemas['issues.delete'].parse({ projectId: 'p' }));
  assert.deepEqual(
    mutateInputSchemas['notes.add'].parse({ projectId: 'p', text: '  note  ' }),
    { projectId: 'p', text: 'note' },
  );
  assert.deepEqual(
    mutateInputSchemas['notes.setCompleted'].parse({ projectId: 'p', id: 'n1', completed: true }),
    { projectId: 'p', id: 'n1', completed: true },
  );
  assert.throws(() => mutateInputSchemas['notes.add'].parse({ projectId: 'p', text: 'two\nlines' }));
  assert.throws(() => mutateInputSchemas['notes.update'].parse({ projectId: 'p', id: 'n1', text: '' }));
});

test('config.get accepts an empty object', () => {
  assert.deepEqual(queryInputSchemas['config.get'].parse({}), {});
});

test('config.set accepts valid budget / profiles sections and rejects illegal values / sections', () => {
  assert.deepEqual(
    mutateInputSchemas['config.set'].parse({ section: 'budget', value: { daily_usd: 100, monthly_usd: 2000 } }),
    { section: 'budget', value: { daily_usd: 100, monthly_usd: 2000 } },
  );
  // profiles section: a non-empty defaultProfile name
  assert.deepEqual(
    mutateInputSchemas['config.set'].parse({ section: 'profiles', value: { defaultProfile: 'plan' } }),
    { section: 'profiles', value: { defaultProfile: 'plan' } },
  );
  const settings = {
    section: 'settings',
    value: { turnNotify: false, taskDispatchMaxConcurrent: null, uiCorsOrigins: ['https://ui.example'] },
  };
  assert.deepEqual(mutateInputSchemas['config.set'].parse(settings), settings);
  assert.throws(() => mutateInputSchemas['config.set'].parse({
    section: 'settings', value: { unknownSetting: true },
  }));
  assert.throws(() => mutateInputSchemas['config.set'].parse({
    section: 'settings', value: { turnNotify: 'false' },
  }));
  assert.throws(() => mutateInputSchemas['config.set'].parse({
    section: 'settings', value: { turnNotify: undefined },
  }));
  // negative / zero rejected
  assert.throws(() => mutateInputSchemas['config.set'].parse({ section: 'budget', value: { daily_usd: -1, monthly_usd: 2000 } }));
  // missing field rejected
  assert.throws(() => mutateInputSchemas['config.set'].parse({ section: 'budget', value: { daily_usd: 100 } }));
  // profiles: empty defaultProfile rejected
  assert.throws(() => mutateInputSchemas['config.set'].parse({ section: 'profiles', value: { defaultProfile: '' } }));
  // unknown section rejected
  assert.throws(() => mutateInputSchemas['config.set'].parse({ section: 'mcp', value: {} }));
});

test('approvals.request enforces per-kind required fields', () => {
  const s = mutateInputSchemas['approvals.request'];
  assert.equal(s.parse({ kind: 'reconnect-platform', platform: 'slack' }).platform, 'slack');
  assert.equal(s.parse({ kind: 'add-machine', machineName: 'atlas' }).machineName, 'atlas');
  assert.throws(() => s.parse({ kind: 'reconnect-platform' }));       // no platform
  assert.throws(() => s.parse({ kind: 'add-machine' }));              // no machineName
  assert.throws(() => s.parse({ kind: 'reboot' }));                   // unknown kind
});

test('schedules.add accepts valid per-type input', () => {
  const s = mutateInputSchemas['schedules.add'];
  assert.equal(s.parse({ type: 'interval', message: 'm', intervalMs: 60000 }).type, 'interval');
  assert.equal(s.parse({ type: 'daily', message: 'm', time: '09:00' }).type, 'daily');
  assert.equal(s.parse({ type: 'weekly', message: 'm', time: '09:00', dayOfWeek: 1 }).dayOfWeek, 1);
  assert.equal(s.parse({ type: 'once', message: 'm', delay: 5000 }).delay, 5000);
  // optional target + fallback
  assert.deepEqual(
    s.parse({ type: 'once', message: 'm', delay: 1, target: { kind: 'project', projectId: 'p' }, fallback: 'skip' }).target,
    { kind: 'project', projectId: 'p' },
  );
});

test('schedules.add rejects missing/invalid per-type fields', () => {
  const s = mutateInputSchemas['schedules.add'];
  assert.throws(() => s.parse({ type: 'interval', message: 'm' }));           // no intervalMs
  assert.throws(() => s.parse({ type: 'daily', message: 'm' }));              // no time
  assert.throws(() => s.parse({ type: 'weekly', message: 'm', time: '09:00' })); // no dayOfWeek
  assert.throws(() => s.parse({ type: 'once', message: 'm' }));               // no delay
  assert.throws(() => s.parse({ type: 'interval', intervalMs: 1 }));          // no message
  assert.throws(() => s.parse({ type: 'weekly', message: 'm', time: 'nope', dayOfWeek: 1 })); // bad time
  assert.throws(() => s.parse({ type: 'weekly', message: 'm', time: '09:00', dayOfWeek: 9 })); // bad dow
});
