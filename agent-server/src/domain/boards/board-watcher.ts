import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@core/log.js';
import type { CortexEventInput, EventBus } from '@events/index.js';
import { boardRepo, type BoardRecord } from '@store/board-repo.js';
import { boardDir, USER_BOARD_CSS } from './board-paths.js';

const log = createLogger('board-watcher');

const DEFAULT_DEBOUNCE_MS = 300;
/** Directories watched per board at most (the board directory, assets/ and anything below). */
const MAX_DIRS_PER_BOARD = 64;

/** A non-recursive watch on one directory. */
type Watch = (dir: string, onChange: (event: string, file: string | null) => void) => fs.FSWatcher;

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

const defaultWatch: Watch = (dir, onChange) => fs.watch(dir, (event, file) => onChange(event, file ? String(file) : null));

interface TreeWatch {
  close(): void;
}

/**
 * Watch `root` and every directory below it, each with its own non-recursive watch, and call
 * `onChange` on any entry event. A directory watch reports its entries by name, so a file replaced
 * by rename (Claude's Edit writes a temp file and renames it over the original) is still seen when
 * it is later written in place (Pi's edit tool). A recursive watch on Linux stays on the replaced
 * file's old inode and goes silent. Subdirectories are re-synced on rename events; `onGone` fires
 * when `root` itself disappears.
 */
function watchTree(root: string, watch: Watch, onChange: () => void, onGone: () => void): TreeWatch | null {
  const dirs = new Map<string, fs.FSWatcher>();
  let closed = false;
  let capped = false;

  const isDir = (p: string): boolean => {
    try {
      return fs.lstatSync(p).isDirectory();
    } catch {
      return false;
    }
  };

  const close = (): void => {
    closed = true;
    for (const w of dirs.values()) w.close();
    dirs.clear();
  };

  const gone = (): void => {
    if (closed) return;
    close();
    onGone();
  };

  /** Stop watching `dir` and everything below it. */
  const drop = (dir: string): void => {
    for (const [d, w] of dirs) {
      if (d === dir || d.startsWith(dir + path.sep)) {
        w.close();
        dirs.delete(d);
      }
    }
  };

  /** Watch `dir` (unless already watched) and walk its subdirectories. */
  const add = (dir: string): void => {
    if (closed) return;
    if (!dirs.has(dir)) {
      if (dirs.size >= MAX_DIRS_PER_BOARD) {
        if (!capped) log.warn(`board ${root}: more than ${MAX_DIRS_PER_BOARD} directories, the rest are not watched`);
        capped = true;
        return;
      }
      let watcher: fs.FSWatcher;
      try {
        watcher = watch(dir, (event, file) => {
          if (closed) return;
          onChange();
          if (event === 'rename') resync(file ? path.join(dir, file) : dir);
        });
      } catch (e) {
        if (dir === root) throw e;
        // A subdirectory that vanished in between; its parent's rename event re-syncs.
        return;
      }
      watcher.on('error', () => (dir === root ? gone() : drop(dir)));
      dirs.set(dir, watcher);
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) add(path.join(dir, entry.name));
    }
  };

  /** An entry appeared, vanished or was replaced: rebuild the watches at and below it. */
  const resync = (target: string): void => {
    if (!isDir(root)) return gone();
    if (target === root) {
      for (const d of [...dirs.keys()]) if (d !== root) drop(d);
    } else {
      drop(target);
    }
    if (isDir(target)) add(target);
  };

  try {
    add(root);
  } catch (e) {
    close();
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') log.warn(`cannot watch board directory ${root}: ${(e as Error).message}`);
    return null;
  }
  return { close };
}

/**
 * Watch active board directories (with everything below them) and the user override stylesheet, and turn bursts of file
 * changes into one `board.updated` per board / one `board.style-updated`. Content-free hints: the
 * clients refetch. A directory that is missing is skipped until a later refresh finds it.
 */
export function createBoardWatcher(deps: BoardWatcherDeps): BoardWatcher {
  const watch = deps.watch ?? defaultWatch;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const boards = new Map<string, { dir: string; tree: TreeWatch }>();
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
    boards.get(id)?.tree.close();
    boards.delete(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
  };

  const watchBoard = (board: BoardRecord, dir: string): void => {
    const tree = watchTree(
      dir,
      watch,
      () => schedule(board.id, { type: 'board.updated', boardId: board.id, projectId: board.projectId }),
      // The directory went away (moved, deleted): drop it; a later refresh picks it up again.
      () => { if (boards.get(board.id)?.tree === tree) unwatchBoard(board.id); },
    );
    if (tree) boards.set(board.id, { dir, tree });
  };

  const watchStyle = (): void => {
    const dir = path.dirname(deps.userCssPath);
    const name = path.basename(deps.userCssPath);
    try {
      styleWatcher = watch(dir, (_event, file) => {
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
