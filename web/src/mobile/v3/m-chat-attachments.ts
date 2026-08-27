// input:  Mobile composer scope, text, shared upload items, and persisted draft identity
// output: Mobile-specific attachment draft loading and persistence effects
// pos:    Mobile chat draft adapter over the neutral attachment controller
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, type MutableRefObject } from 'react';
import type { AttachmentMeta, AttachmentUploadItem } from '@/features/attachments/types';
import { completedAttachmentMetas } from '@/features/attachments/types';
import { loadDraft, saveDraft } from '@/features/workbench/composer-draft';

interface DraftEffectParams {
  draftKey: string | null;
  isDraft: boolean;
  text: string;
  uploads: AttachmentUploadItem[];
  setText: (text: string) => void;
  replaceRestored: (metas: AttachmentMeta[]) => void;
  draftUploadId: MutableRefObject<string | null>;
  draftKeyRef: MutableRefObject<string | null | undefined>;
}

function loadChangedDraft(params: DraftEffectParams): boolean {
  if (params.draftKeyRef.current === params.draftKey) return false;
  params.draftKeyRef.current = params.draftKey;
  if (!params.draftKey) return true;
  const draft = loadDraft(params.draftKey);
  if (params.isDraft && draft?.draftUploadId) params.draftUploadId.current = draft.draftUploadId;
  params.setText(draft?.text ?? '');
  params.replaceRestored(draft?.attachments ?? []);
  return true;
}

function saveCurrentDraft(params: DraftEffectParams): void {
  saveDraft(params.draftKey, {
    text: params.text,
    attachments: completedAttachmentMetas(params.uploads),
    ...(params.isDraft && params.draftUploadId.current ? { draftUploadId: params.draftUploadId.current } : {}),
  });
}

export function usePersistedMobileChatDraft(params: DraftEffectParams): void {
  useEffect(() => {
    if (loadChangedDraft(params)) return;
    saveCurrentDraft(params);
    // Params intentionally mirror the former in-screen effect's content dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.draftKey, params.text, params.uploads, params.isDraft]);
}
