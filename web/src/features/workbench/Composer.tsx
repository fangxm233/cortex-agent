// input:  session state, optimistic send callbacks, media and drafts
// output: guarded desktop composer with send failure recovery
// pos:    Workbench message input and turn-control surface
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useRef, useState, useCallback, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { SLASH_COMMANDS } from './chat-content';
import { slashItemDispatch } from './composer-slash';
import { formatCost } from './right-panel-vm';
import { useSelectedSession } from './SelectedSessionProvider';
import type { AttachmentMeta } from './chat-content';
import { useMediaViewer } from '@/features/media/MediaViewer';
import { useDocViewer } from '@/features/media/DocViewer';
import { mediaKindOf } from '@/features/media/media-kind';
import { VideoThumb } from '@/features/media/VideoThumb';
import { docKindOf } from '@/features/media/doc-kind';
import { fetchFileObjectUrl } from '@/lib/files';
import {
  draftStorageKey, loadDraft, saveDraft, clearDraft, mergeRestoredDraft, type ComposerDraft,
} from './composer-draft';
import { apiBase, authHeaders } from '@/lib/desktop-config';
import { ComposerStatusLine } from './ComposerStatusLine';
import { runOptimisticMutation, type OptimisticUserMessage } from './optimistic-message';

// Composer — extended with file attachment support (15a 附件输入与消息).
// Three entry points for files: "+ attach" button · paste (clipboard images) · drag & drop.
// Files upload to the server's tmp/attachments/<sessionId>/ and are referenced by path.
// Attachment chips show type badges, filenames, sizes, upload progress, and remove buttons.
// The send button enables when text is non-empty OR uploaded attachments are present.

const mono = "'IBM Plex Mono',monospace";
const DASH = '—';
const UPLOAD_PATH = '/api/attachments/upload';

export function ComposerSendFailure({ error }: { error: string }): JSX.Element {
  const L = useVocab();
  return (
    <div
      data-send-error
      role="alert"
      style={{ marginTop: 7, padding: '0 2px', font: `500 10.5px ${mono}`, color: 'var(--proto-danger)' }}
    >
      {L.wbSendFailed} · {L.wbDraftRestored}: {error}
    </div>
  );
}

interface PendingAttachment {
  id: string;
  /** Absent for attachments restored from a persisted draft — those carry only `meta` (the file
   *  bytes already live on the server, referenced by `meta.path`). */
  file?: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  meta?: AttachmentMeta;
  errorMsg?: string;
  /** Local object URL for image/video previews (thumbnail + lightbox); revoked on remove / send. */
  previewUrl?: string;
}

// ── Attachment field accessors (a restored draft attachment has no File, only `meta`) ──
function attMime(a: PendingAttachment): string {
  return a.file?.type ?? a.meta?.mimeType ?? '';
}
function attName(a: PendingAttachment): string {
  return a.file?.name ?? a.meta?.name ?? 'file';
}
function attSize(a: PendingAttachment): number {
  return a.file?.size ?? a.meta?.size ?? 0;
}
function attType(a: PendingAttachment): AttachmentMeta['type'] {
  const m = attMime(a);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'file';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase().slice(0, 4) : 'FILE';
}

function typeColor(type: AttachmentMeta['type']): { bg: string; fg: string } {
  if (type === 'image') return { bg: 'var(--proto-accent-bg)', fg: 'var(--proto-accent)' };
  if (type === 'video') return { bg: 'var(--proto-danger-bg)', fg: 'var(--proto-danger)' };
  return { bg: 'var(--proto-gray)', fg: 'var(--proto-muted)' };
}

async function uploadFile(
  file: File,
  sessionId: string,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<AttachmentMeta> {
  const headers: Record<string, string> = {
    'X-Session-Id': sessionId,
    'X-File-Name': encodeURIComponent(file.name),
    'Content-Type': file.type || 'application/octet-stream',
    // Native-shell auth token (empty in browser/ui-http mode — proxy/Access supplies it).
    ...authHeaders(),
  };

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // Absolute server URL in native-shell/remote mode; relative (same-origin) in browser mode.
    xhr.open('POST', `${apiBase()}${UPLOAD_PATH}`);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.responseType = 'json';
    signal.addEventListener('abort', () => xhr.abort());

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const body = xhr.response as { ok?: boolean; data?: AttachmentMeta; code?: string; message?: string };
        if (body?.ok && body.data) resolve(body.data);
        else reject(new Error(body?.message || `Upload failed (${xhr.status})`));
      } else if (xhr.status === 413) {
        reject(new Error('File too large'));
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    xhr.send(file);
  });
}

let _attachId = 0;
function nextId(): string { return `att_${++_attachId}_${Date.now()}`; }

function completedAttachmentMetas(items: PendingAttachment[]): AttachmentMeta[] {
  return items.filter((item) => item.status === 'done' && item.meta).map((item) => item.meta!);
}

function mergeRestoredAttachments(
  current: PendingAttachment[],
  sent: AttachmentMeta[],
): PendingAttachment[] {
  const currentPaths = new Set(current.flatMap((item) => item.meta?.path ? [item.meta.path] : []));
  const restored = sent.filter((meta) => !currentPaths.has(meta.path)).map((meta) => ({
    id: nextId(), status: 'done' as const, progress: 100, meta,
  }));
  return [...restored, ...current];
}

export function Composer({
  sessionId,
  running,
  backgroundRunning = false,
  turns,
  cost,
  elapsed,
  isDraft = false,
  draftProfile = null,
  draftReloadToken = 0,
  projectId = 'general',
  prepareOptimistic,
  enqueueOptimistic,
  acceptOptimistic,
  rejectOptimistic,
  statusAccessory,
}: {
  sessionId: string;
  running: boolean;
  /** Foreground turn ended but a background task is still running (web bg-hold). `running` stays
   *  true; this only re-labels the running line "background" so the user knows the turn's own
   *  reply is done while background work continues. */
  backgroundRunning?: boolean;
  /** Real agent-turn count (snapshot + `session.turn` delta); null when unknown → rendered as —. */
  turns: number | null;
  /** Last run's total cost in USD (SessionInfo.costUsd snapshot); null while running / never-ran → —. */
  cost: number | null;
  elapsed: string;
  isDraft?: boolean;
  draftProfile?: string | null;
  draftReloadToken?: number;
  projectId?: string;
  prepareOptimistic: (text: string, attachments?: AttachmentMeta[]) => OptimisticUserMessage;
  enqueueOptimistic: (message: OptimisticUserMessage) => void;
  acceptOptimistic: (clientId: string, createdSessionId?: string) => boolean;
  rejectOptimistic: (clientId: string, error: Error) => boolean;
  statusAccessory?: ReactNode;
}): JSX.Element {
  const trpc = useTRPC();
  const L = useVocab();
  const queryClient = useQueryClient();
  const { openMedia } = useMediaViewer();
  const { openDoc } = useDocViewer();
  const { selectCreatedSession } = useSelectedSession();
  const sendMut = useMutation(trpc.sessions.send.mutationOptions());
  const cancelMut = useMutation(trpc.sessions.cancel.mutationOptions());
  const createAndSendMut = useMutation(trpc.sessions.createAndSend.mutationOptions());
  const [composer, setComposer] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  // In draft mode, there's no real sessionId for uploads. Generate a temp UUID once
  // so files have somewhere to land; handleCreateAndSend moves them to the real session dir.
  const draftUploadId = useRef<string | null>(null);
  if (isDraft && !draftUploadId.current) {
    draftUploadId.current = crypto.randomUUID();
  }
  const uploadSessionId = isDraft ? (draftUploadId.current ?? '') : sessionId;

  // Auto-grow the textarea up to a cap.
  const autoGrow = (el: HTMLTextAreaElement | null): void => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  // Re-fit the textarea height whenever `composer` changes for any reason — not just
  // on keystroke (onChange). Switching sessions loads the new scope's draft via
  // setComposer(), which does NOT go through onChange, so without this the height stayed
  // frozen at the previous session's size: a multi-line draft looked collapsed to one row
  // until the user typed, and switching to an empty/new session left the box tall. Layout
  // effect runs synchronously after the value commits, before paint, so there is no flicker.
  useLayoutEffect(() => {
    autoGrow(inputRef.current);
  }, [composer]);

  // ── Slash palette state ──
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashHover, setSlashHover] = useState<number | null>(null);

  // ── Hover states ──
  const [chipHover, setChipHover] = useState(false);
  const [attachHover, setAttachHover] = useState(false);
  const [btnHover, setBtnHover] = useState(false);

  // ── Attachment state ──
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const composerRef = useRef(composer);
  const attachmentsRef = useRef(attachments);
  composerRef.current = composer;
  attachmentsRef.current = attachments;
  const [dragOver, setDragOver] = useState(false);
  const dragCount = useRef(0);
  const dragFileCount = useRef(0);
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  // Re-fit the textarea whenever the chip row appears/disappears: its vertical padding changes with
  // attachments (2px→11px). Pasting an image mutates `attachments` but not `composer`, so the
  // `[composer]` effect above never re-fires and the box stayed fitted to the old padding — the text
  // was clipped. Keyed on the boolean edge so it runs once per toggle, not on every chip mutation.
  const hasAttachmentsForFit = attachments.length > 0;
  useLayoutEffect(() => {
    autoGrow(inputRef.current);
  }, [hasAttachmentsForFit]);

  // ── Per-session draft persistence (localStorage) ──
  // The composer text + successfully-uploaded attachments are persisted per scope so a draft survives
  // an app restart (stable webview/browser origin) and a server restart (the referenced upload files
  // live on the server and are not wiped on boot). One effect both LOADS on scope change and SAVES on
  // content change, distinguished by comparing the live key to a ref — so switching sessions swaps the
  // draft cleanly and never writes the outgoing content under the incoming key.
  const draftKey = draftStorageKey({ isDraft, sessionId, projectId });
  const draftIdentity = `${draftKey ?? ''}:${isDraft ? draftReloadToken : 0}`;
  const currentDraftIdentityRef = useRef(draftIdentity);
  currentDraftIdentityRef.current = draftIdentity;
  const draftKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (draftKeyRef.current !== draftIdentity) {
      // Scope or external prefill changed → load the draft; skip saving on this cycle.
      draftKeyRef.current = draftIdentity;
      if (!draftKey) return; // no stable scope (transient empty sessionId) → leave content untouched
      const d = loadDraft(draftKey);
      if (isDraft && d?.draftUploadId) draftUploadId.current = d.draftUploadId;
      setComposer(d?.text ?? '');
      const restored: PendingAttachment[] = (d?.attachments ?? []).map((m) => ({
        id: nextId(),
        status: 'done' as const,
        progress: 100,
        meta: m,
      }));
      setAttachments((prev) => {
        prev.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
        return restored;
      });
      return;
    }
    // Same scope, content changed → persist.
    saveDraft(draftKey, {
      text: composer,
      attachments: attachments.filter((a) => a.status === 'done' && a.meta).map((a) => a.meta!),
      ...(isDraft && draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
    });
  }, [draftKey, draftIdentity, composer, attachments, isDraft]);

  // Restored media attachments have no local File → fetch an authenticated object URL for the
  // thumbnail/lightbox preview (mirrors the message-stream file cards). Converges (previewUrl set
  // excludes the entry on the next pass).
  useEffect(() => {
    let cancelled = false;
    attachments
      .filter((a) => !a.file && !a.previewUrl && a.status === 'done' && a.meta && (a.meta.type === 'image' || a.meta.type === 'video'))
      .forEach((a) => {
        fetchFileObjectUrl(a.meta!.path, 'inline')
          .then((url) => {
            if (cancelled) { URL.revokeObjectURL(url); return; }
            setAttachments((prev) => prev.map((x) => (x.id === a.id ? { ...x, previewUrl: url } : x)));
          })
          .catch(() => { /* preview is best-effort */ });
      });
    return () => { cancelled = true; };
  }, [attachments]);

  const hasAttachments = attachments.length > 0;
  const doneAttachments = attachments.filter((a) => a.status === 'done');
  const hasText = !!composer.trim();
  const canSend = (hasText || doneAttachments.length > 0) && (!!sessionId || isDraft) && !sendMut.isPending && !createAndSendMut.isPending;
  const composerBorder = slashOpen ? 'var(--proto-accent)' : dragOver ? 'var(--proto-accent)' : 'var(--proto-line-3)';
  // While running, the hint advertises BOTH actions the composer offers: ⏎ appends the message to
  // the turn already in flight, esc stops it. It used to name only the stop shortcut even though
  // ⏎ was live, which made sending mid-turn feel like a slip rather than a choice. The status line
  // directly above already carries the "Running" label, so the word is not repeated here.
  const composerHint = running ? `⏎ ${L.wbSend} · ${L.wbEscToStop}` : `⏎ ${L.wbSend} · ⇧⏎ ${L.wbNewline}`;
  const sendBg = canSend ? 'var(--proto-ink)' : 'var(--proto-line-3)';
  // Real agent-turn count; render — when unknown (no run yet / running turn before first progress).
  const turnsText = turns == null ? DASH : `${turns} ${L.wbTurnsUnit}`;
  // Last run's cost; render — when unknown (running turn not yet finalized / never ran).
  const costText = cost == null ? DASH : formatCost(cost);
  // A session has run at least one turn once it carries a turn count. A fresh/never-run session (draft
  // or created-but-unused) shows just `idle` — no placeholder metrics until a turn produces real values.
  const hasRun = !isDraft && turns != null;

  const q = composer.startsWith('/') ? composer.slice(1).toLowerCase() : '';
  const filtered = SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q));
  const slashList = filtered.length ? filtered : SLASH_COMMANDS;

  // ── File upload ──
  const startUpload = useCallback((pending: PendingAttachment): void => {
    if (!pending.file) return; // restored draft attachment — already on the server, nothing to upload
    const file = pending.file;
    const ctrl = new AbortController();
    abortControllers.current.set(pending.id, ctrl);

    setAttachments((prev) => prev.map((a) => (a.id === pending.id ? { ...a, status: 'uploading' as const, progress: 0 } : a)));

    uploadFile(
      file,
      uploadSessionId,
      (pct) => setAttachments((prev) => prev.map((a) => (a.id === pending.id ? { ...a, progress: pct } : a))),
      ctrl.signal,
    )
      .then((meta) => {
        setAttachments((prev) => prev.map((a) => (a.id === pending.id ? { ...a, status: 'done' as const, progress: 100, meta } : a)));
        abortControllers.current.delete(pending.id);
      })
      .catch((err) => {
        if (err.message === 'Upload cancelled') return;
        setAttachments((prev) => prev.map((a) => (a.id === pending.id ? { ...a, status: 'error' as const, errorMsg: err.message } : a)));
        abortControllers.current.delete(pending.id);
      });
  }, [uploadSessionId]);

  // ── Add files ──
  const addFiles = useCallback((files: FileList | File[]): void => {
    const newAttachments: PendingAttachment[] = Array.from(files).map((file) => ({
      id: nextId(),
      file,
      status: 'pending' as const,
      progress: 0,
      // Local preview for image/video: a client-side object URL powers the chip thumbnail + the
      // click-to-open lightbox (no server round-trip needed for the sender's own file).
      previewUrl: (file.type.startsWith('image/') || file.type.startsWith('video/')) ? URL.createObjectURL(file) : undefined,
    }));
    setAttachments((prev) => [...prev, ...newAttachments]);
    // Start upload for each
    newAttachments.forEach((a) => startUpload(a));
  }, [startUpload]);

  // ── Remove attachment ──
  const removeAttachment = useCallback((id: string): void => {
    const ctrl = abortControllers.current.get(id);
    if (ctrl) ctrl.abort();
    abortControllers.current.delete(id);
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // ── Retry failed upload ──
  const retryAttachment = useCallback((id: string): void => {
    setAttachments((prev) => {
      const a = prev.find((x) => x.id === id);
      if (a) startUpload({ ...a, status: 'pending', progress: 0 });
      return prev;
    });
  }, [startUpload]);

  // ── Drag & drop handlers ──
  const onDragEnter = useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    dragCount.current++;
    if (e.dataTransfer.types.includes('Files')) {
      dragFileCount.current = e.dataTransfer.items.length;
      setDragOver(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    dragCount.current--;
    if (dragCount.current <= 0) {
      dragCount.current = 0;
      setDragOver(false);
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    // Update file count on dragover (may be more accurate than dragenter on some browsers)
    if (e.dataTransfer.types.includes('Files') && e.dataTransfer.items.length > 0) {
      dragFileCount.current = e.dataTransfer.items.length;
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    dragCount.current = 0;
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  // ── Paste handler ──
  const onPaste = useCallback((e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  // ── Send ──
  const restoreRejectedSend = (
    sent: ComposerDraft,
    sentKey: string | null,
    sentIdentity: string,
    error: Error,
  ): void => {
    const stillCurrent = currentDraftIdentityRef.current === sentIdentity;
    const current = stillCurrent
      ? {
          text: composerRef.current,
          attachments: completedAttachmentMetas(attachmentsRef.current),
          ...(draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
        }
      : (loadDraft(sentKey) ?? { text: '', attachments: [] });
    const restored = mergeRestoredDraft(current, sent);
    saveDraft(sentKey, restored);
    if (!stillCurrent) return;
    if (restored.draftUploadId) draftUploadId.current = restored.draftUploadId;
    setComposer(restored.text);
    setAttachments((items) => mergeRestoredAttachments(items, sent.attachments));
    setSendError(error.message);
  };

  const clearConsumedComposer = (): void => {
    clearDraft(draftKey);
    setComposer('');
    setAttachments((items) => {
      items.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
      return [];
    });
    setSlashOpen(false);
    abortControllers.current.forEach((controller) => controller.abort());
    abortControllers.current.clear();
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  const doSendText = (raw: string): void => {
    const text = raw.trim();
    const metas = doneAttachments.map((attachment) => attachment.meta!);
    if (!text && metas.length === 0) return;
    if (!isDraft && !sessionId) return;
    const sent: ComposerDraft = {
      text, attachments: metas,
      ...(isDraft && draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
    };
    const message = prepareOptimistic(text, metas);
    const sentKey = draftKey;
    const sentIdentity = draftIdentity;
    setSendError(null);
    const mutation = runOptimisticMutation<{ sessionId: string } | { accepted: boolean }>({
      message,
      mutate: () => isDraft
        ? createAndSendMut.mutateAsync({
            projectId, profileName: draftProfile ?? undefined, text,
            draftUploadId: sent.draftUploadId,
            ...(metas.length > 0 ? { attachments: metas } : {}),
          } as any)
        : sendMut.mutateAsync({ sessionId, text, ...(metas.length > 0 ? { attachments: metas } : {}) } as any),
      onEnqueue: enqueueOptimistic,
      onAccepted: (entry, data) => {
        if ('sessionId' in data) {
          const selectCreated = acceptOptimistic(entry.clientId, data.sessionId);
          queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
          if (selectCreated) {
            draftUploadId.current = null;
            selectCreatedSession(data.sessionId);
          }
        } else {
          acceptOptimistic(entry.clientId);
        }
      },
      onRejected: (entry, error) => rejectOptimistic(entry.clientId, error),
    });
    clearConsumedComposer();
    void mutation.then((result) => {
      if (!result.ok && result.restore) restoreRejectedSend(sent, sentKey, sentIdentity, result.error);
    });
  };

  const doSend = (): void => {
    if (!canSend) return;
    doSendText(composer);
  };

  const doStop = (): void => {
    if (!sessionId || cancelMut.isPending) return;
    cancelMut.mutate({ sessionId });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Sending while a turn is running is intentional, not a fall-through: the server injects the
      // text into the live turn instead of queuing it. doSend owns the shared keyboard/click guard.
      doSend();
    } else if (e.key === 'Escape') {
      // The slash menu owns Escape while it is open; otherwise Escape is the Stop shortcut the
      // composer hint has always advertised ("Running · esc to stop") but never implemented.
      if (slashOpen) { setSlashOpen(false); return; }
      if (running) { e.preventDefault(); doStop(); }
    }
  };

  // ── Render attachment chip ──
  const renderChip = (a: PendingAttachment): JSX.Element => {
    const mime = attMime(a);
    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');
    const type = attType(a);
    const colors = typeColor(type);
    const name = attName(a);
    const ext = fileExt(name);

    const kind = mediaKindOf(type);
    const canPreview = !!a.previewUrl && a.status !== 'uploading' && a.status !== 'error';

    if (isImage || isVideo) {
      return (
        // Outer wrapper is NOT overflow-hidden so the overhanging × (top:-5/right:-5) shows in full;
        // the inner layer keeps overflow:hidden to clip the thumbnail to the rounded corners.
        <div key={a.id} style={{ position: 'relative', width: 54, height: 54, flex: 'none' }}>
        <div
          role={canPreview ? 'button' : undefined}
          title={canPreview ? name : undefined}
          onClick={canPreview && kind ? () => openMedia({ kind, name, url: a.previewUrl! }) : undefined}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 8,
            border: a.status === 'error' ? '1px solid var(--proto-danger)' : '1px solid var(--proto-line)',
            background: a.previewUrl ? '#000' : 'repeating-linear-gradient(45deg,var(--proto-line),var(--proto-line) 5px,var(--proto-line) 5px,var(--proto-line) 10px)',
            boxSizing: 'border-box',
            overflow: 'hidden',
            cursor: canPreview ? 'pointer' : 'default',
          }}
        >
          {a.previewUrl && isImage && (
            <img src={a.previewUrl} alt={name} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
          {a.previewUrl && isVideo && (
            <VideoThumb src={a.previewUrl} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
          <span
            style={{
              position: 'absolute',
              left: 4,
              bottom: 3,
              font: `500 8px ${mono}`,
              color: 'var(--proto-muted-2)',
              background: 'rgba(255,255,255,.88)',
              padding: '1px 4px',
              borderRadius: 3,
            }}
          >
            {ext}
          </span>
          {isVideo && a.status !== 'uploading' && (
            <>
              <span
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%,-50%)',
                  width: 19,
                  height: 19,
                  borderRadius: '50%',
                  background: 'rgba(25,28,34,.82)',
                  color: 'var(--ink-solid-fg)',
                  fontSize: 7,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingLeft: 1.5,
                  boxSizing: 'border-box',
                }}
              >
                ▶
              </span>
            </>
          )}
          {a.status === 'uploading' && (
            <>
              <span
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(255,255,255,.65)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  font: `600 9px ${mono}`,
                  color: 'var(--proto-accent)',
                }}
              >
                {a.progress}%
              </span>
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  bottom: 0,
                  height: 3,
                  width: `${a.progress}%`,
                  background: 'var(--proto-accent)',
                }}
              />
            </>
          )}
          {a.status === 'error' && (
            <span
              onClick={(e) => { e.stopPropagation(); retryAttachment(a.id); }}
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(255,255,255,.75)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                font: `600 8px ${mono}`,
                color: 'var(--proto-danger)',
              }}
            >
              retry
            </span>
          )}
        </div>
        {/* Remove button — sits on the outer wrapper (outside overflow:hidden) so it isn't clipped */}
        <span
          onClick={(e) => { e.stopPropagation(); removeAttachment(a.id); }}
          style={{
            position: 'absolute',
            top: -5,
            right: -5,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'var(--proto-ink)',
            color: 'var(--ink-solid-fg)',
            fontSize: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1.5px solid var(--proto-card)',
            boxSizing: 'border-box',
            cursor: 'pointer',
          }}
        >
          ×
        </span>
        </div>
      );
    }

    // File chip (PDF, CSV, etc.) — PDF/text open the in-app DocViewer on click once uploaded (the
    // viewer fetches by server path, so it needs the completed `meta.path`); other files stay inert.
    const docKind = docKindOf(name, mime);
    const previewDoc = docKind && a.status === 'done' && a.meta?.path
      ? () => openDoc({ kind: docKind, name, path: a.meta!.path, mimeType: mime })
      : undefined;
    return (
      <div
        key={a.id}
        role={previewDoc ? 'button' : undefined}
        title={previewDoc ? name : undefined}
        onClick={previewDoc}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 54,
          border: a.status === 'error' ? '1px solid var(--proto-danger)' : '1px solid var(--proto-line)',
          background: 'var(--proto-rail)',
          borderRadius: 8,
          padding: '0 12px 0 8px',
          flex: 'none',
          boxSizing: 'border-box',
          cursor: previewDoc ? 'pointer' : 'default',
        }}
      >
        <span
          style={{
            width: 26,
            height: 32,
            borderRadius: 5,
            background: colors.bg,
            color: colors.fg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: `700 8px ${mono}`,
            flex: 'none',
          }}
        >
          {ext}
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ font: `500 10.5px ${mono}`, color: 'var(--proto-ink)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </span>
          <span style={{ font: `400 9px ${mono}`, color: a.status === 'uploading' ? 'var(--proto-accent)' : a.status === 'error' ? 'var(--proto-danger)' : 'var(--proto-muted-3)' }}>
            {a.status === 'uploading' ? `${a.progress}%` : a.status === 'error' ? (a.errorMsg || 'Failed') : formatSize(attSize(a))}
          </span>
        </span>
        {/* Remove button — stops propagation so removing doesn't also trigger the card preview. */}
        <span
          onClick={(e) => { e.stopPropagation(); removeAttachment(a.id); }}
          style={{
            position: 'absolute',
            top: -5,
            right: -5,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'var(--proto-ink)',
            color: 'var(--ink-solid-fg)',
            fontSize: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1.5px solid var(--proto-card)',
            boxSizing: 'border-box',
            cursor: 'pointer',
          }}
        >
          ×
        </span>
      </div>
    );
  };

  return (
    <div style={{ flex: 'none' }}>
      <div
        ref={dropZoneRef}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        style={{ maxWidth: 756, margin: '0 auto', padding: '0 32px 18px', position: 'relative' }}
      >
        {/* Slash palette */}
        {slashOpen && (
          <div
            style={{
              position: 'absolute',
              left: 32,
              right: 32,
              bottom: '100%',
              marginBottom: -2,
              border: '1px solid var(--proto-line)',
              borderRadius: 12,
              boxShadow: '0 6px 24px rgba(16,24,40,.08)',
              background: 'var(--proto-card)',
              overflow: 'hidden',
              zIndex: 10,
            }}
          >
            {slashList.map((c, i) => (
              <div
                key={c.cmd}
                onMouseEnter={() => setSlashHover(i)}
                onMouseLeave={() => setSlashHover((h) => (h === i ? null : h))}
                onClick={() => {
                  const d = slashItemDispatch(c.cmd);
                  if (d) doSendText(d.text);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 14px',
                  background: slashHover === i || i === 0 ? 'var(--proto-accent-bg)' : 'var(--proto-card)',
                  cursor: 'pointer',
                }}
              >
                <span style={{ font: `600 12px ${mono}`, color: i === 0 ? 'var(--proto-accent)' : 'var(--proto-muted)' }}>{c.cmd}</span>
                <span style={{ fontSize: 11.5, color: 'var(--proto-muted-2)', marginLeft: 12 }}>{c.desc}</span>
              </div>
            ))}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '7px 14px',
                borderTop: '1px solid var(--proto-alt)',
                background: 'var(--proto-rail)',
              }}
            >
              <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-faint)' }}>↑↓ {L.wbNavigate} · ⏎ {L.wbRun} · {L.wbEscDismiss}</span>
            </div>
          </div>
        )}

        {/* Running / idle status line with its optional right-aligned accessory. */}
        <ComposerStatusLine
          running={running}
          text={running
            ? `${backgroundRunning ? L.pillBackground : L.pillRunning} · ${elapsed} · ${turnsText}`
            : (hasRun ? `${L.wbIdle} · ${elapsed} · ${turnsText} · ${costText}` : L.wbIdle)}
          accessory={statusAccessory}
        />

        {/* Composer card — doubles as drop zone (15a) */}
        <div
          style={{
            position: 'relative',
            border: dragOver ? '1.5px dashed var(--proto-accent)' : '1.5px solid ' + composerBorder,
            borderRadius: 12,
            background: dragOver ? 'var(--proto-rail)' : 'var(--proto-card)',
            boxShadow: dragOver ? 'none' : '0 1px 2px rgba(16,24,40,.04)',
            padding: '10px 12px 10px 14px',
          }}
        >
          {/* Drop state — empty composer: replace content with centered drop prompt */}
          {dragOver && !hasAttachments ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                padding: '22px 12px',
              }}
            >
              <span style={{ font: `600 11.5px ${mono}`, color: 'var(--proto-accent)' }}>
                {dragFileCount.current > 0
                  ? L.wbDropFilesPlural.replace('{n}', String(dragFileCount.current))
                  : L.wbDropFilesSingular}
              </span>
              <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>
                {L.wbAttachPath}
              </span>
            </div>
          ) : (
            <>
              {/* Drop state with existing attachments: dim content + overlay */}
              <div
                style={{
                  opacity: dragOver ? 0.4 : 1,
                  pointerEvents: dragOver ? 'none' : 'auto',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Attachment chips row */}
                    {hasAttachments && (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 8,
                          padding: '2px 2px 10px',
                          borderBottom: '1px solid var(--proto-line-2)',
                        }}
                      >
                        {attachments.map(renderChip)}
                      </div>
                    )}

                    {/* Text input */}
                    <textarea
                      ref={inputRef}
                      data-composer-input
                      rows={1}
                      value={composer}
                      onChange={(e) => {
                        const v = e.target.value;
                        setComposer(v);
                        setSendError(null);
                        setSlashOpen(v.startsWith('/'));
                        // Height is re-fit by the useLayoutEffect on `composer`.
                      }}
                      onKeyDown={onKey}
                      onPaste={onPaste}
                      placeholder={hasAttachments ? L.wbAttachPlaceholder : L.composerPh}
                      style={{
                        width: '100%',
                        fontSize: 13.5,
                        lineHeight: 1.5,
                        color: 'var(--proto-ink)',
                        fontFamily: 'inherit',
                        padding: hasAttachments ? '11px 2px' : '2px 0',
                        border: 'none',
                        outline: 'none',
                        resize: 'none',
                        background: 'transparent',
                        maxHeight: 160,
                        overflowY: 'auto',
                      }}
                    />

                    {/* Action row */}
                    <div style={{ display: 'flex', alignItems: 'center', marginTop: 0 }}>
                      {/* "+ attach" chip */}
                      <span
                        onClick={() => fileInputRef.current?.click()}
                        onMouseEnter={() => setAttachHover(true)}
                        onMouseLeave={() => setAttachHover(false)}
                        style={{
                          font: `500 10.5px ${mono}`,
                          border: '1px solid ' + (attachHover ? 'var(--proto-accent-border)' : 'var(--proto-line)'),
                          color: attachHover ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
                          padding: '2px 7px',
                          borderRadius: 6,
                          cursor: 'pointer',
                        }}
                      >
                        {L.wbAttach}
                      </span>

                      {/* "/ commands" chip */}
                      <span
                        onClick={() => { setComposer('/'); setSlashOpen(true); }}
                        onMouseEnter={() => setChipHover(true)}
                        onMouseLeave={() => setChipHover(false)}
                        style={{
                          font: `500 10.5px ${mono}`,
                          border: '1px solid ' + (chipHover ? 'var(--proto-accent-border)' : 'var(--proto-line)'),
                          color: chipHover ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
                          padding: '2px 7px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          marginLeft: 8,
                        }}
                      >
                        / {L.commands}
                      </span>

                      <span style={{ marginLeft: 'auto', font: `400 10.5px ${mono}`, color: 'var(--proto-faint)' }}>
                        {hasAttachments ? L.wbAttachHint : composerHint}
                      </span>
                    </div>
                  </div>

                  {/* Send + Stop.
                      Send is ALWAYS rendered. While a turn is running the composer still sends —
                      the server injects the text into the live turn rather than queuing it behind
                      that turn — but the only affordance for it used to be ⏎, with just a Stop
                      button on screen. Showing send as the secondary action next to Stop makes the
                      keyboard behaviour visible instead of accidental. */}
                  <div
                    style={{
                      flex: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginTop: hasAttachments ? 2 : 0,
                    }}
                  >
                    <button
                      type="button"
                      data-action="send"
                      aria-label={L.wbSend}
                      title={running ? `${L.wbSend} · ⏎` : undefined}
                      disabled={!canSend}
                      onClick={doSend}
                      style={{
                        flex: 'none',
                        width: running ? 30 : 34,
                        height: running ? 30 : 34,
                        padding: 0,
                        borderRadius: running ? 9 : 10,
                        // Running: outlined/secondary so Stop stays the primary action.
                        background: running ? 'transparent' : sendBg,
                        border: running ? `1.5px solid ${canSend ? 'var(--proto-accent-border)' : 'var(--proto-line)'}` : 'none',
                        boxSizing: 'border-box',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: canSend ? 'pointer' : 'default',
                      }}
                    >
                      <svg
                        width={running ? 12 : 14}
                        height={running ? 12 : 14}
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke={running ? (canSend ? 'var(--proto-accent)' : 'var(--proto-line-3)') : 'var(--ink-solid-fg)'}
                        strokeWidth="1.8"
                      >
                        <path d="M7 12V2M3 6l4-4 4 4" />
                      </svg>
                    </button>
                    {running && (
                      <div
                        data-action="stop"
                        title={`${L.stop} · esc`}
                        onClick={doStop}
                        onMouseEnter={() => setBtnHover(true)}
                        onMouseLeave={() => setBtnHover(false)}
                        style={{
                          flex: 'none',
                          width: 34,
                          height: 34,
                          borderRadius: 10,
                          background: btnHover ? 'var(--ink-solid-hover)' : 'var(--proto-ink)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: cancelMut.isPending ? 'default' : 'pointer',
                        }}
                      >
                        <span style={{ width: 11, height: 11, background: 'var(--proto-card)', borderRadius: 2 }} />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Floating overlay when dragging with existing attachments */}
              {dragOver && hasAttachments && (
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%,-50%)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 3,
                    background: 'rgba(251,251,254,.94)',
                    border: '1px solid var(--proto-accent-border)',
                    borderRadius: 10,
                    padding: '10px 18px',
                    boxShadow: '0 2px 8px rgba(70,85,212,.10)',
                    zIndex: 2,
                  }}
                >
                  <span style={{ font: `600 11.5px ${mono}`, color: 'var(--proto-accent)' }}>
                    {dragFileCount.current > 0
                      ? L.wbDropAddMoreN.replace('{n}', String(dragFileCount.current))
                      : L.wbDropAddMore}
                  </span>
                  <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>
                    {L.wbDragOverCount.replace('{n}', String(attachments.length)).replace('{m}', String(attachments.length + dragFileCount.current))}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {sendError && <ComposerSendFailure error={sendError} />}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              addFiles(e.target.files);
              e.target.value = '';
            }
          }}
          style={{ display: 'none' }}
        />
      </div>
    </div>
  );
}
