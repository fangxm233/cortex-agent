import * as fs from 'node:fs';
import * as path from 'node:path';
import { commissionsRoot, DRAFT_DIR_PREFIX } from './commission-paths.js';
import { commissionRepo } from '@store/commission-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';

/** What the client asked for when creating a session in commission mode. `new` starts a fresh
 *  contract (the server creates the draft dir); `join` attaches the session to a commission that
 *  already landed, which is how a commission spans more than one session. */
export type CommissionCreateRequest =
  | { mode: 'new' }
  | { mode: 'join'; commissionId: string };

/** Registry fields a commission-mode session is created with. Exactly one is ever set. */
export interface CommissionSessionFields {
  commissionId?: string | null;
  commissionDraft?: string | null;
}

/**
 * Resolve a create-time commission request into registry fields, creating the draft directory for
 * `new`. The server owns this directory (v1 let the agent create it, which made the name
 * non-deterministic); `commission-finalize` renames it to the approved slug, so the
 * `_draft-<session name>` shape here is the same one its validation expects.
 *
 * Throws on failure rather than degrading to a normal session: a user who picked commission mode
 * and silently got an ordinary session would only find out much later.
 */
export async function resolveCommissionCreate(
  projectId: string,
  sessionName: string,
  request: CommissionCreateRequest,
  deps: {
    findCommission?: (id: string) => Promise<{ status: string } | null | undefined>;
    mkdir?: (dir: string) => void;
    resolveRoot?: (projectId: string) => string | null;
  } = {},
): Promise<CommissionSessionFields> {
  if (request.mode === 'join') {
    const find = deps.findCommission ?? ((id: string) => commissionRepo.find(id));
    const commission = await find(request.commissionId);
    if (!commission) throw new Error(`Unknown commission ${request.commissionId}`);
    if (commission.status !== 'active') {
      throw new Error(`Commission ${request.commissionId} is ${commission.status}; only an active commission accepts new sessions`);
    }
    return { commissionId: request.commissionId, commissionDraft: null };
  }

  const { draftDir } = startCommissionDraft(projectId, sessionName, {
    mkdir: deps.mkdir, resolveRoot: deps.resolveRoot,
  });
  return { commissionId: null, commissionDraft: draftDir };
}

/**
 * Create (or reuse) the draft directory for `sessionName` and return both halves of its identity.
 * Split out of {@link resolveCommissionCreate} because three callers need exactly this and nothing
 * else: session creation, the `cortex_commission_start` tool, and the composer switching a live
 * session into the mode (DR-0037 v4).
 *
 * `mkdir -p` is the idempotency: a second call on the same session lands on the same directory,
 * which is what lets the tool be called twice without consequence.
 */
export function startCommissionDraft(
  projectId: string,
  sessionName: string,
  deps: { mkdir?: (dir: string) => void; resolveRoot?: (projectId: string) => string | null } = {},
): { draftDir: string; dir: string } {
  const root = (deps.resolveRoot ?? commissionsRoot)(projectId);
  if (!root) throw new Error(`Project ${projectId} has no context directory; commission mode needs one`);
  const draftDir = DRAFT_DIR_PREFIX + sessionName;
  const dir = path.join(root, draftDir);
  (deps.mkdir ?? ((target: string) => fs.mkdirSync(target, { recursive: true })))(dir);
  return { draftDir, dir };
}

export type CommissionEnterResult =
  | { ok: true; draftDir: string; dir: string; alreadyDrafting: boolean }
  | { ok: false; error: string };

export interface CommissionEnterDeps {
  getSession?: (id: string) => Promise<{
    projectId?: string | null; name?: string | null;
    commissionId?: string | null; commissionDraft?: string | null;
  } | null>;
  setDraft?: (sessionId: string, draftDir: string | null) => Promise<unknown>;
  start?: typeof startCommissionDraft;
  resolveRoot?: (projectId: string) => string | null;
}

/**
 * Put a session into the drafting half of commission mode: directory on disk, `commissionDraft` in
 * the registry. The single implementation behind both entries — the agent's `cortex_commission_start`
 * and the user's composer switch — so the two cannot drift into different states.
 *
 * Idempotent, and a no-op refusal once the session is bound: one commission per session, and a
 * bound one is terminal (a second contract would orphan the first).
 */
export async function enterCommissionDraft(
  sessionId: string,
  deps: CommissionEnterDeps = {},
): Promise<CommissionEnterResult> {
  const session = await (deps.getSession ?? ((id: string) => sessionStore.getById(id)))(sessionId);
  if (!session) return { ok: false, error: `unknown session ${sessionId}` };
  if (session.commissionId) {
    return { ok: false, error: `this session is already bound to commission ${session.commissionId} — open a new session for another one` };
  }
  if (!session.projectId || !session.name) {
    return { ok: false, error: 'session record is missing its project or name' };
  }
  const alreadyDrafting = !!session.commissionDraft;
  try {
    const { draftDir, dir } = (deps.start ?? startCommissionDraft)(
      session.projectId, session.name, { resolveRoot: deps.resolveRoot },
    );
    if (!alreadyDrafting) {
      await (deps.setDraft ?? ((id: string, value: string | null) => sessionStore.setCommissionDraft(id, value)))(sessionId, draftDir);
    }
    return { ok: true, draftDir, dir, alreadyDrafting };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Leave the drafting half: clear the registry field and remove the directory IF nothing was
 *  written into it. A draft holding real text is left on disk — the user can read it, and silently
 *  deleting someone's writing is never the right default. */
export async function leaveCommissionDraft(
  sessionId: string,
  deps: CommissionEnterDeps & {
    readContract?: (file: string) => string | null;
    removeDir?: (dir: string) => void;
  } = {},
): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
  const session = await (deps.getSession ?? ((id: string) => sessionStore.getById(id)))(sessionId);
  if (!session) return { ok: false, error: `unknown session ${sessionId}` };
  if (session.commissionId) return { ok: false, error: 'a bound commission cannot be left; close the commission instead' };
  // Read the directory name off the record BEFORE clearing it: the store may hand back the same
  // object it caches, and clearing the field first would leave nothing to point at on disk.
  const draftDir = session.commissionDraft;
  if (!draftDir) return { ok: true, removed: false };
  await (deps.setDraft ?? ((id: string, value: string | null) => sessionStore.setCommissionDraft(id, value)))(sessionId, null);

  const root = session.projectId ? (deps.resolveRoot ?? commissionsRoot)(session.projectId) : null;
  if (!root) return { ok: true, removed: false };
  const dir = path.join(root, draftDir);
  const read = deps.readContract ?? ((file: string) => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
  });
  if ((read(path.join(dir, 'contract.md')) ?? '').trim()) return { ok: true, removed: false };
  try {
    (deps.removeDir ?? ((target: string) => fs.rmSync(target, { recursive: true, force: true })))(dir);
    return { ok: true, removed: true };
  } catch {
    return { ok: true, removed: false };
  }
}
