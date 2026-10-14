import * as fs from 'node:fs';
import { boardRepo, type BoardRecord } from '@store/board-repo.js';
import type {
  UiServiceDeps,
  BoardInfo,
  BoardDecisionEntry,
  BoardStyle,
  DecisionActionKind,
  QueryParams,
} from '../types.js';
import { resolveProjectRoot, resolveMemoryFilePath } from './memory.js';
import {
  boardRelPath,
  DECISIONS_FILE,
  DEFAULT_BOARD_CSS,
  USER_BOARD_CSS,
} from '@domain/boards/board-paths.js';

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: 'not-found' });
}

/** Registry record → DTO (epoch ms → ISO strings; absent close fields → null). */
export function toBoardInfo(record: BoardRecord): BoardInfo {
  return {
    id: record.id,
    projectId: record.projectId,
    slug: record.slug,
    title: record.title,
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    closedAt: record.closedAt != null ? new Date(record.closedAt).toISOString() : null,
    closeNote: record.closeNote ?? null,
  };
}

function store(deps: UiServiceDeps): NonNullable<UiServiceDeps['boardStore']> {
  return deps.boardStore ?? boardRepo;
}

export async function handleBoardsList(
  deps: UiServiceDeps,
  params: QueryParams<'boards.list'>,
): Promise<BoardInfo[]> {
  let records = await store(deps).list(params.projectId);
  if (params.status) records = records.filter((r) => r.status === params.status);
  return records.map(toBoardInfo);
}

export async function handleBoardsGet(
  deps: UiServiceDeps,
  params: QueryParams<'boards.get'>,
): Promise<BoardInfo> {
  const record = await store(deps).find(params.boardId);
  if (!record) throw notFound(`board not found: ${params.boardId}`);
  return toBoardInfo(record);
}

const DECISION_ACTIONS = new Set<string>(['approve', 'explain', 'revise']);

/** Fold the append-only decisions.jsonl into stream entries: each `kind:'decision'` item becomes
 *  an entry, later `kind:'action'` lines merge into that entry's actions — the same DecisionItem
 *  shape the transcript renders. Malformed lines and actions for unknown ids are skipped. */
export function foldDecisionLines(content: string): BoardDecisionEntry[] {
  const byId = new Map<string, BoardDecisionEntry>();
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    let line: any;
    try { line = JSON.parse(raw); } catch { continue; }
    if (line?.kind === 'decision' && Array.isArray(line.items)) {
      for (const item of line.items) {
        if (typeof item?.id !== 'string' || byId.has(item.id)) continue;
        byId.set(item.id, {
          ts: String(line.ts ?? ''),
          sessionId: String(line.sessionId ?? ''),
          item: {
            id: item.id,
            title: String(item.title ?? ''),
            decision: String(item.decision ?? ''),
            context: String(item.context ?? ''),
            reasoning: String(item.reasoning ?? ''),
            actions: [],
          },
        });
      }
    } else if (line?.kind === 'action' && typeof line.decisionId === 'string') {
      const entry = byId.get(line.decisionId);
      if (!entry || !DECISION_ACTIONS.has(String(line.action))) continue;
      entry.item.actions.push({
        action: line.action as DecisionActionKind,
        ...(typeof line.message === 'string' && line.message ? { message: line.message } : {}),
        ts: String(line.ts ?? ''),
      });
    }
  }
  return [...byId.values()];
}

export async function handleBoardsDecisions(
  deps: UiServiceDeps,
  params: QueryParams<'boards.decisions'>,
): Promise<BoardDecisionEntry[]> {
  const record = await store(deps).find(params.boardId);
  if (!record) throw notFound(`board not found: ${params.boardId}`);
  const root = resolveProjectRoot(deps, record.projectId);
  let abs: string;
  try {
    abs = resolveMemoryFilePath(root, boardRelPath(record.slug, DECISIONS_FILE));
  } catch {
    return [];   // no projection file yet
  }
  return foldDecisionLines(fs.readFileSync(abs, 'utf8'));
}

function readOptional(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The shipped preset plus the user's optional override; the default never leaves the install. */
export async function handleBoardsStyle(
  deps: UiServiceDeps,
  _params: QueryParams<'boards.style'>,
): Promise<BoardStyle> {
  const paths = deps.boardStylePaths ?? { defaultCss: DEFAULT_BOARD_CSS, userCss: USER_BOARD_CSS };
  return {
    defaultCss: readOptional(paths.defaultCss) ?? '',
    userCss: readOptional(paths.userCss),
  };
}
