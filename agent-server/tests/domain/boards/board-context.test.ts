import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BoardRepo } from '../../../src/store/board-repo.js';
import { loadBoardPromptContext } from '../../../src/domain/boards/board-context.js';
import { buildBoardBlock } from '../../../src/domain/runs/prompt.js';
import { resolveConversationBoard } from '../../../src/orchestration/conversation-request.js';

let root: string;
let repo: BoardRepo;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-board-ctx-'));
  // As a release that could close boards wrote it: one board done, one abandoned.
  fs.writeFileSync(path.join(root, 'boards.json'), JSON.stringify({ boards: [
    { id: 'b-done', projectId: 'proj', slug: 'shipped', title: 'Shipped', status: 'done', createdAt: 1, updatedAt: 3, closedAt: 3, closeNote: 'fine' },
    { id: 'b-gone', projectId: 'proj', slug: 'dropped', title: 'Dropped', status: 'abandoned', createdAt: 1, updatedAt: 2, closedAt: 2 },
  ] }));
  repo = new BoardRepo(path.join(root, 'boards.json'));
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const contextDeps = () => ({
  findBoard: (id: string) => repo.find(id),
  resolveDir: (projectId: string, slug: string) => (projectId === 'proj' ? path.join(root, 'ctx', 'boards', slug) : null),
});

test('a board an older release recorded as closed reads normally and is injected', async () => {
  const before = fs.readFileSync(path.join(root, 'boards.json'), 'utf8');
  for (const [id, title, slug] of [['b-done', 'Shipped', 'shipped'], ['b-gone', 'Dropped', 'dropped']]) {
    assert.deepEqual(await loadBoardPromptContext(id, contextDeps()), { id, title, dir: path.join(root, 'ctx', 'boards', slug) });
  }

  const marked: string[] = [];
  const context = await resolveConversationBoard(
    { sessionId: 's1', boardId: 'b-done', boardBlockFor: null } as never,
    { isFreshSession: false },
    { load: (id) => loadBoardPromptContext(id, contextDeps()), markDelivered: async (_s, id) => { marked.push(id); } },
  );
  assert.ok(context);
  assert.match(buildBoardBlock(context), /^\[Board\] This session is bound to the board "Shipped" \(b-done\)\./);
  assert.deepEqual(marked, ['b-done']);
  assert.equal(fs.readFileSync(path.join(root, 'boards.json'), 'utf8'), before, 'reading leaves the file as it was');
});

test('no block when the board record is gone or its project has no context directory', async () => {
  assert.equal(await loadBoardPromptContext('nope', contextDeps()), null);
  assert.equal(await loadBoardPromptContext('b-done', { ...contextDeps(), resolveDir: () => null }), null);
});
