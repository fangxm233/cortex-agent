// input:  composer scope, text and uploaded attachment metadata
// output: per-session draft storage and project draft prefill
// pos:    Persistent composer utilities for desktop and mobile
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { AttachmentMeta } from './chat-content';

/** A persisted composer draft. `draftUploadId` is only set for a new-session (draft-mode) composer,
 *  where uploaded files land under attachments/<draftUploadId>/ before the session exists — it must
 *  round-trip so restored attachment paths keep resolving and the send-time dir move targets the
 *  same source directory. */
export interface ComposerDraft {
  text: string;
  attachments: AttachmentMeta[];
  draftUploadId?: string;
}

export const DRAFT_KEY_PREFIX = 'cortex.composerDraft.';

/** The localStorage key for a composer scope, or null when there is nothing stable to key on.
 *  A new-session draft keys per project (one persistent draft per project's "+ New"); a real
 *  session keys by its session id. */
export function draftStorageKey(scope: {
  isDraft: boolean;
  sessionId?: string | null;
  projectId?: string | null;
}): string | null {
  if (scope.isDraft) return `${DRAFT_KEY_PREFIX}new.${scope.projectId ?? 'general'}`;
  if (scope.sessionId) return `${DRAFT_KEY_PREFIX}session.${scope.sessionId}`;
  return null;
}

/** A draft carries nothing worth persisting when it has no text and no attachments. */
export function isDraftEmpty(d: ComposerDraft | null | undefined): boolean {
  if (!d) return true;
  return d.text.trim().length === 0 && d.attachments.length === 0;
}

function isAttachmentMeta(m: unknown): m is AttachmentMeta {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    typeof o.path === 'string' &&
    typeof o.size === 'number' &&
    typeof o.mimeType === 'string' &&
    (o.type === 'image' || o.type === 'video' || o.type === 'file')
  );
}

/** Parse a stored JSON string into a validated draft (null when absent / malformed / empty). Pure —
 *  testable without a DOM. Drops any attachment entry that is not a well-formed AttachmentMeta. */
export function parseDraft(raw: string | null | undefined): ComposerDraft | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const rec = o as Record<string, unknown>;
  const text = typeof rec.text === 'string' ? rec.text : '';
  const attachments = Array.isArray(rec.attachments) ? rec.attachments.filter(isAttachmentMeta) : [];
  const draftUploadId = typeof rec.draftUploadId === 'string' ? rec.draftUploadId : undefined;
  const draft: ComposerDraft = { text, attachments, ...(draftUploadId ? { draftUploadId } : {}) };
  return isDraftEmpty(draft) ? null : draft;
}

/** Serialize a draft for storage (only the persisted fields). */
export function serializeDraft(d: ComposerDraft): string {
  return JSON.stringify({
    text: d.text,
    attachments: d.attachments,
    ...(d.draftUploadId ? { draftUploadId: d.draftUploadId } : {}),
  });
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Load the persisted draft for a key (null when none / no key / no storage). */
export function loadDraft(key: string | null): ComposerDraft | null {
  if (!key) return null;
  const s = storage();
  if (!s) return null;
  try {
    return parseDraft(s.getItem(key));
  } catch {
    return null;
  }
}

/** Persist a draft for a key. An empty draft removes the entry (no stale empty keys accumulate). */
export function saveDraft(key: string | null, d: ComposerDraft): void {
  if (!key) return;
  const s = storage();
  if (!s) return;
  try {
    if (isDraftEmpty(d)) {
      s.removeItem(key);
      return;
    }
    s.setItem(key, serializeDraft(d));
  } catch {
    // quota exceeded / private mode — best-effort, drop silently.
  }
}

/** Replace only the text of a project draft; existing uploaded attachments remain attached. */
export function mergeDraftPrefill(existing: ComposerDraft | null, text: string): ComposerDraft {
  return {
    text,
    attachments: existing?.attachments ?? [],
    ...(existing?.draftUploadId ? { draftUploadId: existing.draftUploadId } : {}),
  };
}

/** Seed a project's new-session draft without sending or creating a session. */
export function prefillProjectDraft(projectId: string, text: string): void {
  const key = draftStorageKey({ isDraft: true, projectId });
  saveDraft(key, mergeDraftPrefill(loadDraft(key), text));
}

/** Remove the persisted draft for a key (called on successful send). */
export function clearDraft(key: string | null): void {
  if (!key) return;
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(key);
  } catch {
    // ignore
  }
}
