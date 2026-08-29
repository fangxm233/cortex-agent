// input:  node:fs, commission-paths, commissionRepo
// output: draft-directory creation and commission-mode session options
// pos:    Commission-mode session creation: the server owns the draft dir (DR-0037 v2)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { commissionsRoot, DRAFT_DIR_PREFIX } from './commission-paths.js';
import { commissionRepo } from '@store/commission-repo.js';

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

  const root = (deps.resolveRoot ?? commissionsRoot)(projectId);
  if (!root) throw new Error(`Project ${projectId} has no context directory; commission mode needs one`);
  const draft = DRAFT_DIR_PREFIX + sessionName;
  const mkdir = deps.mkdir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }));
  mkdir(path.join(root, draft));
  return { commissionId: null, commissionDraft: draft };
}
