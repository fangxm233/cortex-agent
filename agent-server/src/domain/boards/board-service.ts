import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { boardRepo, newBoardId, type BoardRecord } from '@store/board-repo.js';
import { sessionStore, type Session } from '@store/session-registry-repo.js';
import type { CortexEventInput } from '@events/index.js';
import { BOARD_ASSETS_DIR, BOARD_FILE, BOARD_SCAFFOLD, BOARDS_DIR } from './board-paths.js';
import { projectStore } from '@domain/projects/project-store.js';

/** The registry, the session store and the filesystem a board operation touches. The server only
 *  registers, binds and notifies; it never writes board.html after the scaffold. */
export interface BoardServiceDeps {
  boards: Pick<typeof boardRepo, 'find' | 'findBySlug' | 'list' | 'add' | 'update'>;
  sessions: Pick<typeof sessionStore, 'getById' | 'listWorkers' | 'bindBoard'>;
  contextDir: (projectId: string) => string | null;
  readScaffold: () => Promise<string>;
  publish: (event: CortexEventInput) => void;
  now: () => number;
  newId: () => string;
}

export function defaultBoardServiceDeps(publish: (event: CortexEventInput) => void): BoardServiceDeps {
  return {
    boards: boardRepo,
    sessions: sessionStore,
    contextDir: (projectId) => projectStore.get(projectId)?.contextDir ?? null,
    readScaffold: () => fs.readFile(BOARD_SCAFFOLD, 'utf8'),
    publish,
    now: () => Date.now(),
    newId: newBoardId,
  };
}

export type BoardOpenRequest = { title: string } | { board: string };

export interface BoardOpenResult {
  board: BoardRecord;
  /** Absolute board directory. */
  dir: string;
  created: boolean;
  reopened: boolean;
  /** Session ids bound by this call (the caller first). */
  bound: string[];
}

export class BoardError extends Error {}

/** Normalize a title to a directory slug; null when nothing slug-safe remains (e.g. CJK only). */
export function slugifyBoardTitle(title: string): string | null {
  const slug = title.trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
  return slug || null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The scaffold with every `{{title}}` replaced by the escaped board title. */
export function fillScaffold(scaffold: string, title: string): string {
  return scaffold.replaceAll('{{title}}', escapeHtml(title));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** First free slug: neither registered in the project nor present on disk. */
async function freeSlug(base: string, projectId: string, root: string, deps: BoardServiceDeps): Promise<string> {
  for (let n = 1; ; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (await deps.boards.findBySlug(projectId, slug)) continue;
    if (await exists(path.join(root, slug))) continue;
    return slug;
  }
}

async function createBoard(session: Session, title: string, deps: BoardServiceDeps): Promise<{ board: BoardRecord; dir: string }> {
  const contextDir = deps.contextDir(session.projectId);
  if (!contextDir) throw new BoardError(`project ${session.projectId} has no context directory`);
  const id = deps.newId();
  const root = path.join(contextDir, BOARDS_DIR);
  const slug = await freeSlug(slugifyBoardTitle(title) ?? `board-${id}`, session.projectId, root, deps);
  const dir = path.join(root, slug);
  await fs.mkdir(path.join(dir, BOARD_ASSETS_DIR), { recursive: true });
  await fs.writeFile(path.join(dir, BOARD_FILE), fillScaffold(await deps.readScaffold(), title), { flag: 'wx' });
  const now = deps.now();
  const board: BoardRecord = {
    id, projectId: session.projectId, slug, title, status: 'active', createdAt: now, updatedAt: now,
  };
  await deps.boards.add(board);
  return { board, dir };
}

async function findBoard(session: Session, ref: string, deps: BoardServiceDeps): Promise<BoardRecord> {
  const board = await deps.boards.find(ref) ?? await deps.boards.findBySlug(session.projectId, ref);
  if (board) return board;
  const known = (await deps.boards.list(session.projectId)).map(b => `${b.slug} (${b.id})`);
  throw new BoardError(`no board "${ref}" in project ${session.projectId}`
    + (known.length ? `; known boards: ${known.join(', ')}` : ''));
}

/** A lead binds its active workers that have no board yet along with itself (a worker that opened
 *  its own board keeps it); a worker binds only itself. */
async function bindTargets(session: Session, deps: BoardServiceDeps): Promise<Session[]> {
  if (session.teamLeadId) return [session];
  const workers = await deps.sessions.listWorkers(session.sessionId);
  return [session, ...workers.filter(w => w.workerRetiredAt == null && !w.boardId)];
}

/**
 * Create a board (`{title}`) or attach to an existing one (`{board}`: id or slug), and bind the
 * calling session — plus its active, still unboarded workers when it is a lead. Attaching to a closed board
 * reopens it. A session holds one board; binding replaces any earlier one.
 */
export async function openBoard(
  sessionId: string,
  request: BoardOpenRequest,
  deps: BoardServiceDeps,
): Promise<BoardOpenResult> {
  const session = await deps.sessions.getById(sessionId);
  if (!session) throw new BoardError(`session not found: ${sessionId}`);

  let board: BoardRecord;
  let dir: string;
  let created = false;
  let reopened = false;
  if ('title' in request) {
    const title = request.title.trim();
    if (!title) throw new BoardError('title must not be empty');
    ({ board, dir } = await createBoard(session, title, deps));
    created = true;
  } else {
    const found = await findBoard(session, request.board.trim(), deps);
    const contextDir = deps.contextDir(found.projectId);
    if (!contextDir) throw new BoardError(`project ${found.projectId} has no context directory`);
    dir = path.join(contextDir, BOARDS_DIR, found.slug);
    board = found;
    if (found.status !== 'active') {
      board = await deps.boards.update(found.id, (r) => {
        if (r.status === 'active') return false;
        r.status = 'active';
        delete r.closedAt;
        delete r.closeNote;
      }) ?? found;
      reopened = true;
    }
  }

  const targets = await bindTargets(session, deps);
  for (const target of targets) {
    await deps.sessions.bindBoard(target.sessionId, board.id);
    deps.publish({ type: 'session.board', sessionId: target.sessionId, channel: target.channel });
  }
  deps.publish({ type: 'board.updated', boardId: board.id, projectId: board.projectId });
  return { board, dir, created, reopened, bound: targets.map(t => t.sessionId) };
}

/** Close the calling session's board as done/abandoned. Bindings stay; a closed board is simply
 *  no longer injected, and board_open on it reopens it. */
export async function closeBoard(
  sessionId: string,
  request: { status: 'done' | 'abandoned'; note?: string },
  deps: BoardServiceDeps,
): Promise<BoardRecord> {
  const session = await deps.sessions.getById(sessionId);
  if (!session) throw new BoardError(`session not found: ${sessionId}`);
  if (!session.boardId) throw new BoardError('this session is not bound to a board');
  let closedAs: string | null = null;
  const updated = await deps.boards.update(session.boardId, (r) => {
    if (r.status !== 'active') {
      closedAs = r.status;
      return false;
    }
    r.status = request.status;
    r.closedAt = deps.now();
    if (request.note?.trim()) r.closeNote = request.note.trim();
  });
  if (!updated) throw new BoardError(`board not found: ${session.boardId}`);
  if (closedAs) throw new BoardError(`board is already ${closedAs}`);
  deps.publish({ type: 'board.updated', boardId: updated.id, projectId: updated.projectId });
  return updated;
}
