import { loadDraft, mergeRestoredDraft, saveDraft, type ComposerDraft } from './composer-draft';

// A message coming back to the composer from outside it (an unsent message taken back to edit).
// The composer showing that scope merges it in place; with none mounted it joins the stored draft
// and is there the next time the scope opens.

type RestoreHandler = (sent: ComposerDraft) => void;

const handlers = new Map<string, RestoreHandler>();

/** The mounted composer for `key` takes restores from now on; the returned function stops that. */
export function registerComposerRestore(key: string, handler: RestoreHandler): () => void {
  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key);
  };
}

/** Put `sent` back in front of whatever the `key` scope's composer already holds. */
export function restoreIntoComposer(key: string | null, sent: ComposerDraft): void {
  if (!key) return;
  const handler = handlers.get(key);
  if (handler) {
    handler(sent);
    return;
  }
  saveDraft(key, mergeRestoredDraft(loadDraft(key) ?? { text: '', attachments: [] }, sent));
}
