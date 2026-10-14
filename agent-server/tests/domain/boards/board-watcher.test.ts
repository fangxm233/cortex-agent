import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoardWatcher, startBoardWatcher, type BoardWatcher } from '../../../src/domain/boards/board-watcher.js';
import { EventBus } from '../../../src/events/event-bus.js';
import type { BoardRecord } from '../../../src/store/board-repo.js';

let root: string;
let configDir: string;
let records: BoardRecord[];
let events: any[];
let watcher: BoardWatcher | null;
let touched: Array<{ id: string; at: number }>;
let stopStarted: (() => void) | null;

const DEBOUNCE = 40;

function board(id: string): BoardRecord {
  return { id, projectId: 'proj', slug: id, title: id, createdAt: 0, updatedAt: 0 };
}

/** A record as a release that could close boards wrote it. */
function legacyClosed(id: string): BoardRecord {
  return { ...board(id), status: 'done', closedAt: 1, closeNote: 'shipped' } as BoardRecord;
}

function dirOf(b: BoardRecord): string {
  return path.join(root, 'boards', b.slug);
}

function deps() {
  return {
    listBoards: async () => records,
    boardDir: dirOf,
    userCssPath: path.join(configDir, 'board.css'),
    publish: (e: any) => { events.push(e); },
    touch: async (id: string, at: number) => { touched.push({ id, at }); },
    debounceMs: DEBOUNCE,
  };
}

async function settle(ms = DEBOUNCE * 5): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/** Wait until `count` events arrived (fs.watch latency varies under load), then a quiet window so
 *  a stray extra event would still be caught. */
async function eventsReach(count: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (events.length < count && Date.now() < deadline) await settle(20);
  await settle();
}

/** Run `action` and report whether it produced at least one more event. */
async function produces(action: () => void): Promise<boolean> {
  const before = events.length;
  action();
  await eventsReach(before + 1);
  return events.length > before;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-board-watch-'));
  configDir = path.join(root, 'config');
  fs.mkdirSync(configDir);
  for (const id of ['a', 'b', 'c']) fs.mkdirSync(path.join(root, 'boards', id, 'assets'), { recursive: true });
  records = [board('a'), legacyClosed('b')];
  events = [];
  touched = [];
  watcher = null;
  stopStarted = null;
});

afterEach(() => {
  watcher?.stop();
  stopStarted?.();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a burst of edits to a board becomes one board.updated', async () => {
  watcher = createBoardWatcher(deps());
  await watcher.refresh();
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(root, 'boards', 'a', 'board.html'), `<p>${i}</p>`);
  fs.writeFileSync(path.join(root, 'boards', 'a', 'assets', 'shot.png'), 'png');
  await eventsReach(1);
  assert.deepEqual(events, [{ type: 'board.updated', boardId: 'a', projectId: 'proj' }]);
});

test('a run of edits within a minute writes updatedAt once', async () => {
  watcher = createBoardWatcher(deps());
  await watcher.refresh();
  const start = Date.now();
  // Three separate bursts, each its own board.updated, all inside the one-minute interval.
  for (let i = 0; i < 3; i += 1) {
    assert.ok(await produces(() => fs.writeFileSync(path.join(root, 'boards', 'a', 'board.html'), `<p>${i}</p>`)));
  }
  assert.equal(events.length, 3);
  assert.equal(touched.length, 1);
  assert.equal(touched[0].id, 'a');
  assert.ok(touched[0].at >= start);
});

test('the last edit in an interval is written once the interval is up, then nothing more', async () => {
  const INTERVAL = 600;
  watcher = createBoardWatcher({ ...deps(), touchIntervalMs: INTERVAL });
  await watcher.refresh();
  const file = path.join(root, 'boards', 'a', 'board.html');
  assert.ok(await produces(() => fs.writeFileSync(file, '1')));
  assert.equal(touched.length, 1);
  const lastEdit = Date.now();
  assert.ok(await produces(() => fs.writeFileSync(file, '2')));
  assert.equal(touched.length, 1, 'held until the interval is up');
  await settle(INTERVAL + 200);
  assert.equal(touched.length, 2);
  assert.ok(touched[1].at >= lastEdit, 'the held write carries the later change');
  await settle(INTERVAL);
  assert.equal(touched.length, 2);
});

test('every registered board is watched, including one an older release recorded as closed', async () => {
  records = [board('a'), legacyClosed('b'), board('c')];
  watcher = createBoardWatcher(deps());
  await watcher.refresh();
  for (const id of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, 'boards', id, 'board.html'), id);
  await eventsReach(3);
  assert.deepEqual(events.map(e => e.boardId).sort(), ['a', 'b', 'c']);
});

test('a board.html replaced by rename is still seen when later written in place, and so are new assets', async () => {
  const dir = path.join(root, 'boards', 'a');
  const file = path.join(dir, 'board.html');
  fs.writeFileSync(file, 'v0');
  watcher = createBoardWatcher(deps());
  await watcher.refresh();

  // Claude's Edit: a temp file renamed over the original, so board.html gets a new inode.
  const original = fs.statSync(file).ino;
  assert.ok(await produces(() => {
    fs.writeFileSync(`${file}.tmp`, 'v1');
    fs.renameSync(`${file}.tmp`, file);
  }), 'the rename replacement');
  const replaced = fs.statSync(file).ino;
  assert.notEqual(replaced, original);

  // Pi's edit: an in-place write to the replacement.
  assert.ok(await produces(() => fs.writeFileSync(file, 'v2')), 'the in-place write after the replacement');
  assert.equal(fs.statSync(file).ino, replaced);
  assert.ok(await produces(() => fs.writeFileSync(file, 'v3')), 'a second in-place write');

  assert.ok(await produces(() => fs.writeFileSync(path.join(dir, 'assets', 'plot.png'), 'png')), 'a new asset');
  assert.deepEqual(new Set(events.map(e => JSON.stringify(e))), new Set([JSON.stringify({ type: 'board.updated', boardId: 'a', projectId: 'proj' })]));
});

test('directories created or recreated under the board are watched too', async () => {
  const assets = path.join(root, 'boards', 'a', 'assets');
  watcher = createBoardWatcher(deps());
  await watcher.refresh();
  assert.ok(await produces(() => fs.mkdirSync(path.join(assets, 'plots'))));
  assert.ok(await produces(() => fs.writeFileSync(path.join(assets, 'plots', 'p.png'), 'x')), 'a file in a new subdirectory');
  assert.ok(await produces(() => {
    fs.rmSync(assets, { recursive: true });
    fs.mkdirSync(assets);
  }));
  assert.ok(await produces(() => fs.writeFileSync(path.join(assets, 'again.png'), 'x')), 'a file in the recreated assets/');
});

test('refresh follows the registry: a new board is watched, one no longer registered is dropped', async () => {
  watcher = createBoardWatcher(deps());
  await watcher.refresh();
  records = [board('c')];
  await watcher.refresh();
  fs.writeFileSync(path.join(root, 'boards', 'a', 'board.html'), 'x');
  fs.writeFileSync(path.join(root, 'boards', 'c', 'board.html'), 'y');
  await eventsReach(1);
  assert.deepEqual(events, [{ type: 'board.updated', boardId: 'c', projectId: 'proj' }]);
});

test('a missing board directory is skipped until a later refresh finds it', async () => {
  records = [board('later')];
  watcher = createBoardWatcher(deps());
  await watcher.refresh();
  fs.mkdirSync(path.join(root, 'boards', 'later'));
  await watcher.refresh();
  fs.writeFileSync(path.join(root, 'boards', 'later', 'board.html'), 'x');
  await eventsReach(1);
  assert.deepEqual(events, [{ type: 'board.updated', boardId: 'later', projectId: 'proj' }]);
});

test('creating, editing and deleting the user stylesheet each publish board.style-updated', async () => {
  watcher = createBoardWatcher(deps());
  await watcher.refresh();
  const css = path.join(configDir, 'board.css');
  fs.writeFileSync(css, ':root{--proto-accent:red}');
  await eventsReach(1);
  assert.deepEqual(events, [{ type: 'board.style-updated' }]);
  fs.writeFileSync(path.join(configDir, 'settings.json'), '{}');
  await settle();
  assert.equal(events.length, 1, 'other config files are ignored');
  fs.unlinkSync(css);
  await eventsReach(2);
  assert.deepEqual(events, [{ type: 'board.style-updated' }, { type: 'board.style-updated' }]);
});

test('stop closes every watcher and cancels pending events', async () => {
  watcher = createBoardWatcher(deps());
  await watcher.refresh();
  fs.writeFileSync(path.join(root, 'boards', 'a', 'board.html'), 'x');
  watcher.stop();
  await settle();
  fs.writeFileSync(path.join(root, 'boards', 'a', 'board.html'), 'y');
  fs.writeFileSync(path.join(configDir, 'board.css'), 'z');
  await settle();
  assert.deepEqual(events, []);
});

test('the production wiring refreshes on board.updated from the bus', async () => {
  const bus = new EventBus();
  records = [];
  stopStarted = startBoardWatcher(bus, deps());
  records = [board('c')];
  bus.publish({ type: 'board.updated', boardId: 'c', projectId: 'proj' });
  // The refresh is async; keep editing until the new board's watcher reports.
  const deadline = Date.now() + 3_000;
  while (events.length === 0 && Date.now() < deadline) {
    fs.writeFileSync(path.join(root, 'boards', 'c', 'board.html'), String(Date.now()));
    await settle();
  }
  assert.deepEqual(events.slice(0, 1), [{ type: 'board.updated', boardId: 'c', projectId: 'proj' }]);
});
