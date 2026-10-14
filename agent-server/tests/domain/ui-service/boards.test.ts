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
import { handleBoardClose } from '../../../src/domain/ui-service/mutate/boards.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { makeUiDeps, type UiDepsOverrides } from './ui-deps-fixture.js';
import { BoardRepo, type BoardRecord } from '../../../src/store/board-repo.js';

const T0 = Date.UTC(2026, 7, 28, 10, 0, 0);

function record(overrides: Partial<BoardRecord> = {}): BoardRecord {
  return {
    id: 'c1', projectId: 'proj1', slug: 'ship-it', title: 'Ship It',
    status: 'active', createdAt: T0, updatedAt: T0, ...overrides,
  };
}

function makeDeps(overrides: UiDepsOverrides = {}): UiServiceDeps {
  return makeUiDeps(overrides);
}

function storeOf(records: BoardRecord[]): NonNullable<UiServiceDeps['boardStore']> {
  return {
    list: async (projectId?: string) => records.filter((r) => !projectId || r.projectId === projectId),
    find: async (id: string) => records.find((r) => r.id === id) ?? null,
    update: async (id: string, fn: (r: BoardRecord) => void | false) => {
      const r = records.find((x) => x.id === id);
      if (!r) return null;
      if (fn(r) === false) return r;
      r.updatedAt = Date.now();
      return r;
    },
  };
}

test('boards.list filters by project/status and maps epoch ms to ISO', async () => {
  const records = [record(), record({ id: 'c2', slug: 'other', projectId: 'proj2' }),
    record({ id: 'c3', slug: 'done-one', status: 'done', closedAt: T0 + 1000, closeNote: 'ok' })];
  const deps = makeDeps({ boardStore: storeOf(records) });
  const all = await handleBoardsList(deps, {});
  assert.equal(all.length, 3);
  const proj1 = await handleBoardsList(deps, { projectId: 'proj1' });
  assert.deepEqual(proj1.map((c) => c.id), ['c1', 'c3']);
  const done = await handleBoardsList(deps, { status: 'done' });
  assert.equal(done.length, 1);
  assert.equal(done[0].createdAt, new Date(T0).toISOString());
  assert.equal(done[0].closedAt, new Date(T0 + 1000).toISOString());
  assert.equal(done[0].closeNote, 'ok');
  assert.equal(proj1[0].closedAt, null);   // honest null, not fabricated
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

test('boards.close sets status/closedAt/note, publishes, and guards re-close', async () => {
  const records = [record()];
  const published: any[] = [];
  const deps = makeDeps({
    boardStore: storeOf(records),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: (e: any) => { published.push(e); } } as any,
  });
  const closed = await handleBoardClose(deps, { boardId: 'c1', status: 'done', note: 'shipped' });
  assert.ok(closed.ok);
  assert.equal((closed as any).data.status, 'done');
  assert.equal((closed as any).data.closeNote, 'shipped');
  assert.ok((closed as any).data.closedAt);
  assert.deepEqual(published, [{ type: 'board.updated', boardId: 'c1', projectId: 'proj1' }]);

  const again = await handleBoardClose(deps, { boardId: 'c1', status: 'abandoned' });
  assert.ok(!again.ok && (again as any).code === 'already-terminal');
  const missing = await handleBoardClose(deps, { boardId: 'zz', status: 'done' });
  assert.ok(!missing.ok && (missing as any).code === 'not-found');
});

test('two closes racing on the same board: exactly one wins, the other is told it is closed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-board-close-'));
  t.onTestFinished(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const repo = new BoardRepo(path.join(dir, 'boards.json'));
  await repo.add(record());
  const deps = makeDeps({ boardStore: repo, bus: { publish: () => {} } as any });

  const [a, b] = await Promise.all([
    handleBoardClose(deps, { boardId: 'c1', status: 'done', note: 'shipped' }),
    handleBoardClose(deps, { boardId: 'c1', status: 'abandoned', note: 'dropped' }),
  ]);
  assert.deepEqual([a.ok, b.ok], [true, false]);
  assert.equal((b as any).code, 'already-terminal');
  const stored = (await repo.find('c1'))!;
  assert.equal(stored.status, 'done', 'the loser must not overwrite the winner');
  assert.equal(stored.closeNote, 'shipped');
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
