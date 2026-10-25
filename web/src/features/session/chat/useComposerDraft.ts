import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { randomUUID } from '@/lib/random-id';
import { completedAttachmentMetas } from '@/features/attachments/types';
import { useAttachmentUploads, type AttachmentUploadController } from '@/features/attachments/useAttachmentUploads';
import {
  clearDraft, draftStorageKey, loadDraft, mergeRestoredDraft, saveDraft, type ComposerDraft,
} from '@/features/session/composer/composer-draft';

export interface ComposerDraftScope {
  sessionId: string;
  isDraft: boolean;
  projectId: string;
  /** Bumped when another surface replaces the project draft's text (desktop prefill). */
  reloadToken?: number;
}

export interface ComposerDraftState {
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  uploads: AttachmentUploadController;
  /** The scope the composer is writing for right now: storage key plus external reload token. */
  identity: string;
  draftKey: string | null;
  /** What a send consumes: the text plus the finished uploads and, for a draft, their bucket. */
  snapshot: (text: string) => ComposerDraft;
  /** The send consumed the composer; its draft is gone and the uploads are reset. */
  consume: () => void;
  /** Slash commands consume only the text — attachments stay for the next message. */
  consumeText: () => void;
  /** Take a rejected send back. Returns false when the user has moved to another scope, where it
   *  is merged into that scope's stored draft instead. */
  restore: (sent: ComposerDraft, sentKey: string | null, sentIdentity: string) => boolean;
  /** A created session took the draft's upload bucket with it. */
  releaseDraftBucket: () => void;
}

/**
 * The composer's text and uploads, persisted per scope so a draft survives an app or server
 * restart. A new-session draft uploads into a bucket of its own (`draftUploadId`) until
 * createAndSend moves the files into the session it creates; that id round-trips through storage.
 */
export function useComposerDraft(scope: ComposerDraftScope): ComposerDraftState {
  const { isDraft, sessionId } = scope;
  const [text, setText] = useState('');
  const draftKey = draftStorageKey({ isDraft, sessionId, projectId: scope.projectId });
  const identity = `${draftKey ?? ''}:${isDraft ? scope.reloadToken ?? 0 : 0}`;
  // Resolve a restored draft bucket before the upload controller binds, so a scope change never
  // briefly binds a random bucket and then clears the restored metadata on the next render.
  const draftUploadId = useRef<string | null>(null);
  const uploadIdentity = useRef<string | null>(null);
  if (uploadIdentity.current !== identity) {
    uploadIdentity.current = identity;
    draftUploadId.current = isDraft ? (loadDraft(draftKey)?.draftUploadId ?? randomUUID()) : null;
  }
  const uploads = useAttachmentUploads({ scope: identity, bucket: isDraft ? (draftUploadId.current ?? '') : sessionId });
  const latest = useRef({ text, items: uploads.items, identity });
  latest.current = { text, items: uploads.items, identity };

  const withBucket = (draft: ComposerDraft): ComposerDraft => (
    isDraft && draftUploadId.current ? { ...draft, draftUploadId: draftUploadId.current } : draft
  );
  usePersistedDraft({ draftKey, identity, isDraft, text, uploads, setText, draftUploadId, withBucket });

  const restore = (sent: ComposerDraft, sentKey: string | null, sentIdentity: string): boolean => {
    const stillCurrent = latest.current.identity === sentIdentity;
    const current = stillCurrent
      ? {
          text: latest.current.text,
          attachments: completedAttachmentMetas(latest.current.items),
          ...(draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
        }
      : (loadDraft(sentKey) ?? { text: '', attachments: [] });
    const restored = mergeRestoredDraft(current, sent);
    saveDraft(sentKey, restored);
    if (!stillCurrent) return false;
    if (restored.draftUploadId) draftUploadId.current = restored.draftUploadId;
    setText(restored.text);
    uploads.mergeRestored(sent.attachments);
    return true;
  };

  return {
    text,
    setText,
    uploads,
    identity,
    draftKey,
    snapshot: (sentText) => withBucket({ text: sentText, attachments: uploads.completed }),
    consume: () => { clearDraft(draftKey); setText(''); uploads.reset(); },
    consumeText: () => { saveDraft(draftKey, withBucket({ text: '', attachments: uploads.completed })); setText(''); },
    restore,
    releaseDraftBucket: () => { draftUploadId.current = null; },
  };
}

interface PersistInput {
  draftKey: string | null;
  identity: string;
  isDraft: boolean;
  text: string;
  uploads: AttachmentUploadController;
  setText: (text: string) => void;
  draftUploadId: { current: string | null };
  withBucket: (draft: ComposerDraft) => ComposerDraft;
}

/** One effect both LOADS on scope change and SAVES on content change, told apart by comparing the
 *  live identity to a ref — so switching scope swaps the draft cleanly and never writes the
 *  outgoing content under the incoming key. */
function usePersistedDraft(input: PersistInput): void {
  const loadedIdentity = useRef<string | undefined>(undefined);
  const { draftKey, identity, isDraft, text, uploads } = input;
  useEffect(() => {
    if (loadedIdentity.current !== identity) {
      loadedIdentity.current = identity;
      // No stable scope (transient empty sessionId) → leave the content untouched.
      if (!draftKey) return;
      const stored = loadDraft(draftKey);
      if (isDraft && stored?.draftUploadId) input.draftUploadId.current = stored.draftUploadId;
      input.setText(stored?.text ?? '');
      uploads.replaceRestored(stored?.attachments ?? []);
      return;
    }
    saveDraft(draftKey, input.withBucket({ text, attachments: completedAttachmentMetas(uploads.items) }));
    // Content and scope drive this effect; the helpers are re-created every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, identity, text, uploads.items, isDraft, uploads.replaceRestored]);
}
