import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BoardRepo } from '../../../src/store/board-repo.js';
import { SessionRegistryRepo } from '../../../src/store/session-registry-repo.js';
import {
  BoardError, closeBoard, openBoard, slugifyBoardTitle, type BoardServiceDeps,
} from '../../../src/domain/boards/board-service.js';
import { handleBoardWebhook } from '../../../src/orchestration/board-webhook.js';
import { openedText } from '../../../src/domain/mcp/tools/ui-board.js';

let root: string;
let ctx: string;
let sessions: SessionRegistryRepo;
let boards: BoardRepo;
let events: any[];
let deps: BoardServiceDeps;

const SCAFFOLD = '<div class="card">scaffold</div>\n';

async function register(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await sessions.registerSession({ sessionId: id, channel: `web:${id}`, backend: 'claude', kind: 'local', projectId: 'proj', ...extra });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-board-svc-'));
  ctx = path.join(root, 'ctx');
  fs.mkdirSync(ctx);
  sessions = new SessionRegistryRepo(path.join(root, 'session-registry.jsonl'));
  boards = new BoardRepo(path.join(root, 'boards.json'));
  events = [];
  let n = 0;
  deps = {
    boards,
    sessions,
    contextDir: (projectId) => (projectId === 'proj' ? ctx : null),
    readScaffold: async () => SCAFFOLD,
    publish: (e) => { events.push(e); },
    now: () => 1_000,
    newId: () => `b${++n}`,
  };
  await register('lead');
  await register('w-active', { teamLeadId: 'lead', workerName: 'a' });
  await register('w-retired', { teamLeadId: 'lead', workerName: 'r' });
  await sessions.setWorkerRetired('w-retired', 500);
  await register('other');
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('a lead opening a new board gets the directory, scaffold and record, and binds its active workers', async () => {
  const result = await openBoard('lead', { title: 'Ship the Parser' }, deps);
  assert.equal(result.created, true);
  assert.equal(result.board.slug, 'ship-the-parser');
  assert.equal(result.dir, path.join(ctx, 'boards', 'ship-the-parser'));
  assert.equal(fs.readFileSync(path.join(result.dir, 'board.html'), 'utf8'), SCAFFOLD);
  assert.deepEqual(await boards.find('b1'), {
    id: 'b1', projectId: 'proj', slug: 'ship-the-parser', title: 'Ship the Parser',
    status: 'active', createdAt: 1_000, updatedAt: 1_000,
  });
  assert.deepEqual(result.bound, ['lead', 'w-active']);
  assert.equal((await sessions.getById('lead'))?.boardId, 'b1');
  assert.equal((await sessions.getById('w-active'))?.boardId, 'b1');
  assert.equal((await sessions.getById('w-retired'))?.boardId ?? null, null, 'retired workers stay unbound');
  assert.equal((await sessions.getById('other'))?.boardId ?? null, null);
  assert.deepEqual(events.map(e => e.type), ['session.board', 'session.board', 'board.updated']);
  assert.deepEqual(events.at(-1), { type: 'board.updated', boardId: 'b1', projectId: 'proj' });
});

test('a worker opening its own board binds only itself', async () => {
  const result = await openBoard('w-active', { title: 'Side quest' }, deps);
  assert.deepEqual(result.bound, ['w-active']);
  assert.equal((await sessions.getById('lead'))?.boardId ?? null, null);
});

test('a lead opening a board leaves a worker that already has its own board alone', async () => {
  await register('w-fresh', { teamLeadId: 'lead', workerName: 'f' });
  const side = await openBoard('w-active', { title: 'Side quest' }, deps);
  events = [];
  const main = await openBoard('lead', { title: 'Main' }, deps);
  assert.deepEqual(main.bound, ['lead', 'w-fresh']);
  assert.equal((await sessions.getById('w-active'))?.boardId, side.board.id);
  assert.equal((await sessions.getById('w-fresh'))?.boardId, main.board.id);
  assert.deepEqual(events.filter(e => e.type === 'session.board').map(e => e.sessionId), ['lead', 'w-fresh']);
});

test('slugs avoid registered and on-disk names; titles with no ASCII fall back to the id', async () => {
  fs.mkdirSync(path.join(ctx, 'boards', 'taken'), { recursive: true });
  assert.equal((await openBoard('other', { title: 'Taken' }, deps)).board.slug, 'taken-2');
  assert.equal((await openBoard('other', { title: 'Taken' }, deps)).board.slug, 'taken-3');
  assert.equal((await openBoard('other', { title: '看板' }, deps)).board.slug, 'board-b3');
  assert.equal(slugifyBoardTitle('  A_b  c!! '), 'a-b-c');
});

test('attaching by id or slug rebinds; a closed board reopens; one board per session', async () => {
  const first = await openBoard('lead', { title: 'First' }, deps);
  await closeBoard('lead', { status: 'done', note: 'ok' }, deps);
  const second = await openBoard('other', { title: 'Second' }, deps);

  const bySlug = await openBoard('lead', { board: 'second' }, deps);
  assert.equal(bySlug.board.id, second.board.id);
  assert.equal(bySlug.created, false);
  assert.equal((await sessions.getById('lead'))?.boardId, second.board.id, 'the newer binding replaces the old');
  assert.equal((await sessions.getById('w-active'))?.boardId, first.board.id, 'a worker that has a board keeps it');

  const reopened = await openBoard('other', { board: first.board.id }, deps);
  assert.equal(reopened.reopened, true);
  const record = await boards.find(first.board.id);
  assert.equal(record?.status, 'active');
  assert.equal(record?.closedAt, undefined);
  assert.equal(record?.closeNote, undefined);

  await assert.rejects(openBoard('other', { board: 'nope' }, deps), (e: Error) => e instanceof BoardError && /known boards/.test(e.message));
});

test('closing needs a bound session and refuses a second close', async () => {
  await assert.rejects(closeBoard('other', { status: 'done' }, deps), /not bound/);
  await openBoard('other', { title: 'X' }, deps);
  const closed = await closeBoard('other', { status: 'abandoned', note: ' dropped ' }, deps);
  assert.equal(closed.status, 'abandoned');
  assert.equal(closed.closeNote, 'dropped');
  assert.equal(closed.closedAt, 1_000);
  assert.deepEqual(events.at(-1), { type: 'board.updated', boardId: closed.id, projectId: 'proj' });
  await assert.rejects(closeBoard('other', { status: 'done' }, deps), /already abandoned/);
  assert.equal((await sessions.getById('other'))?.boardId, closed.id, 'the binding stays after closing');
});

test('the webhook validates its input and reports service errors as failures', async () => {
  assert.equal((await handleBoardWebhook({ action: 'open', title: 'T' }, deps)).success, false);
  assert.match((await handleBoardWebhook({ sessionId: 'other', action: 'open', title: 'T', board: 'x' }, deps)).error!, /exactly one/);
  assert.match((await handleBoardWebhook({ sessionId: 'other', action: 'close', status: 'maybe' }, deps)).error!, /done or abandoned/);
  assert.match((await handleBoardWebhook({ sessionId: 'other', action: 'close', status: 'done' }, deps)).error!, /not bound/);

  const opened = await handleBoardWebhook({ sessionId: 'lead', action: 'open', title: 'Hooked' }, deps);
  assert.equal(opened.success, true);
  const data = opened.data as any;
  assert.equal(data.slug, 'hooked');
  assert.deepEqual(data.bound, ['lead', 'w-active']);
  const text = openedText(data);
  assert.match(text, /Created board "Hooked"/);
  assert.match(text, /board\.html/);
  assert.match(text, /1 worker/);
  assert.match(text, /scaffold has an example of every component/);
});
