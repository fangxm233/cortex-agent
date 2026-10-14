import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sessionStore } from '@store/session-registry-repo.js';
import { boardRepo } from '@store/board-repo.js';
import type { EventBus } from '@events/index.js';
import type { RawDecisionItem } from '@store/conversation-history-repo.js';
import { boardDecisionsFile } from './board-paths.js';

/** decisions.jsonl is a mechanical server-side projection: agents never write it. One line per
 *  send_decision call (`kind:'decision'`) plus one line per user response (`kind:'action'`). */
export type BoardDecisionLine =
  | { v: 1; kind: 'decision'; ts: string; sessionId: string; items: RawDecisionItem[] }
  | { v: 1; kind: 'action'; ts: string; sessionId: string; decisionId: string; action: string; message?: string };

export interface DecisionProjectionDeps {
  getSession?: (sessionId: string) => Promise<{ boardId?: string | null } | null>;
  findBoard?: (id: string) => Promise<{ projectId: string; slug: string } | null>;
  resolveFile?: (projectId: string, slug: string) => string | null;
  appendLine?: (filePath: string, line: string) => Promise<void>;
  /** Where the `board.updated` hint goes once a line lands; absent ⇒ no hint. */
  bus?: Pick<EventBus, 'publish'> | null;
}

interface ProjectionTarget { filePath: string; boardId: string; projectId: string }

async function resolveTarget(sessionId: string, deps: DecisionProjectionDeps): Promise<ProjectionTarget | null> {
  const getSession = deps.getSession ?? ((id: string) => sessionStore.getById(id));
  const findBoard = deps.findBoard ?? ((id: string) => boardRepo.find(id));
  const resolveFile = deps.resolveFile ?? boardDecisionsFile;
  const session = await getSession(sessionId);
  if (!session?.boardId) return null;
  const board = await findBoard(session.boardId);
  if (!board) return null;
  const filePath = resolveFile(board.projectId, board.slug);
  if (!filePath) return null;
  return { filePath, boardId: session.boardId, projectId: board.projectId };
}

async function defaultAppend(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, text, 'utf8');
}

async function appendProjection(sessionId: string, line: BoardDecisionLine, deps: DecisionProjectionDeps): Promise<boolean> {
  const target = await resolveTarget(sessionId, deps);
  if (!target) return false;
  await (deps.appendLine ?? defaultAppend)(target.filePath, `${JSON.stringify(line)}\n`);
  deps.bus?.publish({ type: 'board.updated', boardId: target.boardId, projectId: target.projectId });
  return true;
}

/** Mirror one send_decision call into the session's board. False when the session has none. */
export async function projectBoardDecisions(
  args: { sessionId: string; ts: string; items: RawDecisionItem[] },
  deps: DecisionProjectionDeps = {},
): Promise<boolean> {
  return appendProjection(args.sessionId, { v: 1, kind: 'decision', ts: args.ts, sessionId: args.sessionId, items: args.items }, deps);
}

/** Mirror one user response (approve/explain/revise) to a projected decision. */
export async function projectBoardDecisionAction(
  args: { sessionId: string; ts: string; decisionId: string; action: string; message?: string },
  deps: DecisionProjectionDeps = {},
): Promise<boolean> {
  return appendProjection(args.sessionId, {
    v: 1, kind: 'action', ts: args.ts, sessionId: args.sessionId,
    decisionId: args.decisionId, action: args.action,
    ...(args.message ? { message: args.message } : {}),
  }, deps);
}
