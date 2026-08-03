// input:  draft/session ids, attachment metadata, workspace filesystem
// output: moveDraftAttachments with canonical truthful aliases
// pos:    Promotes Web draft uploads into session storage
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createLogger } from '@core/log.js';
import { WORKSPACE_DIR, resolveWorkspaceRelPath } from '@core/paths.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';

const log = createLogger('draft-attachments');
const ATTACHMENTS_DIR = path.resolve(WORKSPACE_DIR, 'attachments');
const SAFE_BUCKET_ID = /^[A-Za-z0-9_-]+$/;

interface PromotionCandidate {
  source: string;
  destination: string;
  promotedAlias: string;
}

interface MoveDraftAttachmentsOptions {
  draftUploadId: string | null;
  sessionId: string;
  attachments: AttachmentMeta[];
}

type PromotionOutcome =
  | { kind: 'promoted'; alias: string }
  | { kind: 'retain' }
  | { kind: 'drop' };

function bucketDirectory(id: string): string | null {
  if (!SAFE_BUCKET_ID.test(id)) return null;
  const directory = path.resolve(ATTACHMENTS_DIR, id);
  return path.dirname(directory) === ATTACHMENTS_DIR ? directory : null;
}

function resolveCandidate(
  draftUploadId: string, sessionId: string, attachment: AttachmentMeta,
): PromotionCandidate | null {
  const draftDir = bucketDirectory(draftUploadId);
  const sessionDir = bucketDirectory(sessionId);
  const prefix = `workspace/attachments/${draftUploadId}/`;
  if (!draftDir || !sessionDir || !attachment.path.startsWith(prefix)) return null;
  const fileName = attachment.path.slice(prefix.length);
  if (!fileName || path.basename(fileName) !== fileName || fileName === '.' || fileName === '..') return null;
  const source = resolveWorkspaceRelPath(attachment.path);
  if (!source || path.dirname(source) !== draftDir) return null;
  return {
    source,
    destination: path.join(sessionDir, fileName),
    promotedAlias: `workspace/attachments/${sessionId}/${fileName}`,
  };
}

async function isRegularFile(filename: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filename);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function promoteCandidate(candidate: PromotionCandidate): Promise<PromotionOutcome> {
  if (!await isRegularFile(candidate.source)) return { kind: 'drop' };
  try {
    await fs.mkdir(path.dirname(candidate.destination), { recursive: true });
    await fs.link(candidate.source, candidate.destination);
  } catch {
    return await isRegularFile(candidate.source) ? { kind: 'retain' } : { kind: 'drop' };
  }
  if (!await isRegularFile(candidate.destination)) {
    await fs.unlink(candidate.destination).catch(() => {});
    return await isRegularFile(candidate.source) ? { kind: 'retain' } : { kind: 'drop' };
  }
  await fs.unlink(candidate.source).catch((error) => {
    log.warn(`Promoted draft attachment but could not remove source: ${(error as Error).message}`);
  });
  return { kind: 'promoted', alias: candidate.promotedAlias };
}

export async function moveDraftAttachments(
  opts: MoveDraftAttachmentsOptions,
): Promise<AttachmentMeta[]> {
  if (!opts.draftUploadId || opts.attachments.length === 0) return opts.attachments;
  const outcomes = new Map<string, PromotionOutcome>();
  const result: AttachmentMeta[] = [];
  for (const attachment of opts.attachments) {
    const candidate = resolveCandidate(opts.draftUploadId, opts.sessionId, attachment);
    if (!candidate) continue;
    if (!outcomes.has(candidate.source)) {
      outcomes.set(candidate.source, await promoteCandidate(candidate));
    }
    const outcome = outcomes.get(candidate.source)!;
    if (outcome.kind === 'promoted') result.push({ ...attachment, path: outcome.alias });
    else if (outcome.kind === 'retain') result.push(attachment);
  }
  return result;
}
