import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleBoardsList,
  handleBoardsGet,
  handleBoardsDecisions,
  handleBoardsStyle,
  foldDecisionLines,
} from '../../../src/domain/ui-service/query/boards.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { makeUiDeps, type UiDepsOverrides } from './ui-deps-fixture.js';
import type { BoardRecord } from '../../../src/store/board-repo.js';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';

const T0 = Date.UTC(2026, 7, 28, 10, 0, 0);

function record(overrides: Partial<BoardRecord> = {}): BoardRecord {
  return {
    id: 'c1', projectId: 'proj1', slug: 'ship-it', title: 'Ship It',
    createdAt: T0, updatedAt: T0, ...overrides,
  };
}

function makeDeps(overrides: UiDepsOverrides = {}): UiServiceDeps {
  return makeUiDeps(overrides);
}

function storeOf(records: BoardRecord[]): NonNullable<UiServiceDeps['boardStore']> {
  return {
    list: async (projectId?: string) => records.filter((r) => !projectId || r.projectId === projectId),
    find: async (id: string) => records.find((r) => r.id === id) ?? null,
  };
}

test('boards.list filters by project, sorts by updatedAt newest first and maps epoch ms to ISO', async () => {
  const records = [
    record(),
    record({ id: 'c2', slug: 'other', projectId: 'proj2', updatedAt: T0 + 2000 }),
    record({ id: 'c3', slug: 'later', updatedAt: T0 + 1000 }),
  ];
  const deps = makeDeps({ boardStore: storeOf(records) });
  assert.deepEqual((await handleBoardsList(deps, {})).map((c) => c.id), ['c2', 'c3', 'c1']);
  const proj1 = await handleBoardsList(deps, { projectId: 'proj1' });
  assert.deepEqual(proj1.map((c) => c.id), ['c3', 'c1']);
  assert.deepEqual(proj1[1], {
    id: 'c1', projectId: 'proj1', slug: 'ship-it', title: 'Ship It',
    createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
  });
});

test('a record an older release wrote with status/closedAt/closeNote reads as a plain board', async () => {
  const legacy = { ...record(), status: 'done', closedAt: T0 + 1000, closeNote: 'ok' } as BoardRecord;
  const deps = makeDeps({ boardStore: storeOf([legacy]) });
  const [listed] = await handleBoardsList(deps, {});
  assert.deepEqual(Object.keys(listed).sort(), ['createdAt', 'id', 'projectId', 'slug', 'title', 'updatedAt']);
  assert.deepEqual(await handleBoardsGet(deps, { boardId: 'c1' }), listed);
});

test('the boards router has no close route', () => {
  const router = createAppRouter(createUiService(makeDeps()));
  const procedures = Object.keys((router as any)._def.procedures).filter((name) => name.startsWith('boards.'));
  assert.deepEqual(procedures.sort(), ['boards.decisions', 'boards.get', 'boards.list', 'boards.style']);
});

test('boards.get returns the DTO and throws not-found for unknown ids', async () => {
  const deps = makeDeps({ boardStore: storeOf([record()]) });
  const got = await handleBoardsGet(deps, { boardId: 'c1' });
  assert.equal(got.slug, 'ship-it');
  await assert.rejects(
    handleBoardsGet(deps, { boardId: 'nope' }),
    (e: any) => e.code === 'not-found',
  );
});

test('foldDecisionLines merges action lines into items and skips garbage', () => {
  const lines = [
    JSON.stringify({ v: 1, kind: 'decision', ts: 't1', sessionId: 's1', items: [{ id: 'd1', title: 'T', decision: 'D', context: 'C', reasoning: 'R' }] }),
    'not json at all',
    JSON.stringify({ v: 1, kind: 'action', ts: 't2', sessionId: 's1', decisionId: 'd1', action: 'revise', message: 'again' }),
    JSON.stringify({ v: 1, kind: 'action', ts: 't3', sessionId: 's1', decisionId: 'unknown', action: 'approve' }),
    JSON.stringify({ v: 1, kind: 'action', ts: 't4', sessionId: 's1', decisionId: 'd1', action: 'bogus-kind' }),
  ].join('\n');
  const entries = foldDecisionLines(lines);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, 's1');
  assert.deepEqual(entries[0].item.actions, [{ action: 'revise', message: 'again', ts: 't2' }]);
});

test('boards.decisions reads the real projection file under the project root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-board-ui-'));
  t.onTestFinished(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const dir = path.join(root, 'boards', 'ship-it');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'),
    JSON.stringify({ v: 1, kind: 'decision', ts: 't1', sessionId: 's1', items: [{ id: 'd1', title: 'T', decision: 'D', context: 'C', reasoning: 'R' }] }) + '\n');
  const deps = makeDeps({
    boardStore: storeOf([record()]),
    projectStore: { list: () => [], get: (id: string) => (id === 'proj1' ? { id: 'proj1', name: 'p', kind: 'general', contextDir: root } as any : undefined), exists: () => true, getDefault: () => ({} as any), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
  });
  const entries = await handleBoardsDecisions(deps, { boardId: 'c1' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].item.id, 'd1');

  // Missing projection file → empty stream, not an error.
  fs.unlinkSync(path.join(dir, 'decisions.jsonl'));
  assert.deepEqual(await handleBoardsDecisions(deps, { boardId: 'c1' }), []);
});

test('boards.style returns the default preset and the user override, null when absent', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-board-style-'));
  t.onTestFinished(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const defaultCss = path.join(dir, 'board.css');
  const userCss = path.join(dir, 'config', 'board.css');
  fs.writeFileSync(defaultCss, '.card{}');
  const deps = makeDeps({ boardStylePaths: { defaultCss, userCss } });
  assert.deepEqual(await handleBoardsStyle(deps, {}), { defaultCss: '.card{}', userCss: null });

  fs.mkdirSync(path.dirname(userCss));
  fs.writeFileSync(userCss, ':root{--proto-accent:red}');
  assert.deepEqual(await handleBoardsStyle(deps, {}), { defaultCss: '.card{}', userCss: ':root{--proto-accent:red}' });
});

test('boards.style reads the shipped preset by default', async () => {
  const style = await handleBoardsStyle(makeDeps(), {});
  assert.equal(typeof style.defaultCss, 'string');
  assert.ok(style.defaultCss.length > 0, 'defaults/board/board.css ships with the server');
});
