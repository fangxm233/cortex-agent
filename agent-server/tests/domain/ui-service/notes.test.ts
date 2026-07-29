// input:  notes query/mutation handlers, UiService facade, temp project context
// output: project scoping, CRUD result and private audit regressions
// pos:    Tests the transport-neutral project notes UI service
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleNotesList } from '../../../src/domain/ui-service/query/notes.js';
import {
  handleNotesAdd,
  handleNotesUpdate,
  handleNotesSetCompleted,
  handleNotesDelete,
  handleNotesClearCompleted,
} from '../../../src/domain/ui-service/mutate/notes.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

interface PublishedEvent {
  type: string;
  op?: string;
  args?: unknown;
}

function tempContext(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cortex-ui-notes-'));
}

function makeDeps(contextDir: string | null, published: PublishedEvent[] = []): UiServiceDeps {
  return {
    projectStore: {
      list: () => [],
      get: (id: string) => contextDir && id === 'atlas'
        ? ({ id: 'atlas', name: 'atlas', kind: 'user', contextDir } as any)
        : undefined,
      exists: () => false,
      getDefault: () => ({ id: 'general', name: 'general', kind: 'general', contextDir: '/g' } as any),
      createProject: () => ({} as any),
    },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/nonexistent/PENDING_APPROVALS.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: {
      subscribe: () => ({ unsubscribe: () => {} }),
      publish: (event: PublishedEvent) => { published.push(event); },
    } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: {} as any,
  };
}

test('notes handlers scope NOTES.md through the registered project', async () => {
  const dir = tempContext();
  const deps = makeDeps(dir);
  assert.deepEqual(await handleNotesList(deps, { projectId: 'atlas' }), []);

  const added = await handleNotesAdd(deps, { projectId: 'atlas', text: 'Run evaluation' });
  assert.equal(added.ok, true);
  const note = (added as any).data;
  assert.equal(note.text, 'Run evaluation');
  assert.ok(fs.existsSync(path.join(dir, 'NOTES.md')));

  const updated = await handleNotesUpdate(deps, { projectId: 'atlas', id: note.id, text: 'Run full evaluation' });
  assert.equal((updated as any).data.text, 'Run full evaluation');
  const completed = await handleNotesSetCompleted(deps, { projectId: 'atlas', id: note.id, completed: true });
  assert.equal((completed as any).data.completed, true);
  const cleared = await handleNotesClearCompleted(deps, { projectId: 'atlas' });
  assert.deepEqual((cleared as any).data, { cleared: 1 });
  assert.deepEqual(await handleNotesList(deps, { projectId: 'atlas' }), []);
});

test('notes delete returns not-found for an unknown note or project', async () => {
  const dir = tempContext();
  const unknownNote = await handleNotesDelete(makeDeps(dir), { projectId: 'atlas', id: 'missing' });
  assert.equal(unknownNote.ok, false);
  assert.equal((unknownNote as any).code, 'not-found');
  const unknownProject = await handleNotesAdd(makeDeps(null), { projectId: 'missing', text: 'Nope' });
  assert.equal(unknownProject.ok, false);
  assert.equal((unknownProject as any).code, 'not-found');
});

test('notes mutation audit events never include private note text', async () => {
  const events: PublishedEvent[] = [];
  const service = createUiService(makeDeps(tempContext(), events));
  const secret = 'private calibration reminder';
  const result = await service.mutate('notes.add' as any, { projectId: 'atlas', text: secret } as any);
  assert.equal(result.ok, true);
  const audit = events.find((event) => event.type === 'ui.mutate-invoked');
  assert.ok(audit);
  assert.equal(audit?.op, 'notes.add');
  assert.deepEqual(audit?.args, { projectId: 'atlas' });
  assert.ok(!JSON.stringify(audit).includes(secret));
});
