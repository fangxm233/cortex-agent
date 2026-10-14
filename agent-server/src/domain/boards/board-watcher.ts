import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@core/log.js';
import type { CortexEventInput, EventBus } from '@events/index.js';
import { boardRepo, type BoardRecord } from '@store/board-repo.js';
import { boardDir, USER_BOARD_CSS } from './board-paths.js';

const log = createLogger('board-watcher');

const DEFAULT_DEBOUNCE_MS = 300;

type Watch = (target: string, opts: { recursive: boolean }, onChange: (event: string, file: string | null) => void) => fs.FSWatcher;

export interface BoardWatcherDeps {
  /** Every registered board; only active ones are watched. */
  listBoards: () => Promise<BoardRecord[]>;
  boardDir: (board: BoardRecord) => string | null;
  /** The optional user override stylesheet. Its directory is watched, so the file may come and go. */
  userCssPath: string;
  publish: (event: CortexEventInput) => void;
  debounceMs?: number;
  watch?: Watch;
}

export interface BoardWatcher {
  /** Re-read the registry and watch exactly the active boards' directories. */
  refresh(): Promise<void>;
  stop(): void;
}

const defaultWatch: Watch = (target, opts, onChange) => fs.watch(target, opts, (event, file) => onChange(event, file ? String(file) : null));

/**
 * Watch active board directories and the user override stylesheet, and turn bursts of file
 * changes into one `board.updated` per board / one `board.style-updated`. Content-free hints: the
 * clients refetch. A directory that is missing is skipped until a later refresh finds it.
 */
export function createBoardWatcher(deps: BoardWatcherDeps): BoardWatcher {
  const watch = deps.watch ?? defaultWatch;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const boards = new Map<string, { dir: string; watcher: fs.FSWatcher }>();
  const timers = new Map<string, NodeJS.Timeout>();
  let styleWatcher: fs.FSWatcher | null = null;
  let stopped = false;

  const schedule = (key: string, event: CortexEventInput): void => {
    if (stopped) return;
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      if (!stopped) deps.publish(event);
    }, debounceMs));
  };

  const unwatchBoard = (id: string): void => {
    boards.get(id)?.watcher.close();
    boards.delete(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
  };

  const watchBoard = (board: BoardRecord, dir: string): void => {
    try {
      const watcher = watch(dir, { recursive: true }, () => {
        schedule(board.id, { type: 'board.updated', boardId: board.id, projectId: board.projectId });
      });
      // The directory went away (moved, deleted): drop it; a later refresh picks it up again.
      watcher.on('error', () => unwatchBoard(board.id));
      boards.set(board.id, { dir, watcher });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`cannot watch board ${board.id} at ${dir}: ${(e as Error).message}`);
    }
  };

  const watchStyle = (): void => {
    const dir = path.dirname(deps.userCssPath);
    const name = path.basename(deps.userCssPath);
    try {
      styleWatcher = watch(dir, { recursive: false }, (_event, file) => {
        if (file === null || file === name) schedule('style', { type: 'board.style-updated' });
      });
      styleWatcher.on('error', () => { styleWatcher?.close(); styleWatcher = null; });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`cannot watch ${dir}: ${(e as Error).message}`);
    }
  };

  let refreshing: Promise<void> = Promise.resolve();
  const refreshOnce = async (): Promise<void> => {
    if (stopped) return;
    const wanted = new Map<string, { board: BoardRecord; dir: string }>();
    for (const board of await deps.listBoards()) {
      if (board.status !== 'active') continue;
      const dir = deps.boardDir(board);
      if (dir) wanted.set(board.id, { board, dir });
    }
    if (stopped) return;
    for (const [id, current] of boards) {
      if (wanted.get(id)?.dir !== current.dir) unwatchBoard(id);
    }
    for (const [id, { board, dir }] of wanted) {
      if (!boards.has(id)) watchBoard(board, dir);
    }
    if (!styleWatcher) watchStyle();
  };

  return {
    refresh() {
      // Serialized: two overlapping refreshes would both add the same new board.
      refreshing = refreshing.then(refreshOnce).catch((e) => {
        log.warn(`board watcher refresh failed: ${(e as Error).message}`);
      });
      return refreshing;
    },
    stop() {
      stopped = true;
      for (const id of [...boards.keys()]) unwatchBoard(id);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      styleWatcher?.close();
      styleWatcher = null;
    },
  };
}

/** Production wiring: the live registry, the bus, and a refresh whenever a board changes (opened,
 *  closed, reopened). Returns the stop function for shutdown. */
export function startBoardWatcher(
  bus: Pick<EventBus, 'publish' | 'subscribe'>,
  deps: Partial<BoardWatcherDeps> = {},
): () => void {
  const watcher = createBoardWatcher({
    listBoards: () => boardRepo.list(),
    boardDir: (board) => boardDir(board.projectId, board.slug),
    userCssPath: USER_BOARD_CSS,
    publish: (event) => bus.publish(event),
    ...deps,
  });
  const sub = bus.subscribe('board.updated', () => { void watcher.refresh(); });
  void watcher.refresh();
  return () => {
    sub.unsubscribe();
    watcher.stop();
  };
}
