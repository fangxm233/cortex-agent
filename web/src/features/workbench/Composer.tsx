import { useRef, useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { SLASH_COMMANDS } from './chat-content';
import { slashItemDispatch } from './composer-slash';
import { formatCost } from './right-panel-vm';
import { useSelectedSession } from './SelectedSessionProvider';
import type { AttachmentMeta } from './chat-content';

// Composer — extended with file attachment support (15a 附件输入与消息).
// Three entry points for files: "+ attach" button · paste (clipboard images) · drag & drop.
// Files upload to the server's tmp/attachments/<sessionId>/ and are referenced by path.
// Attachment chips show type badges, filenames, sizes, upload progress, and remove buttons.
// The send button enables when text is non-empty OR uploaded attachments are present.

const mono = "'IBM Plex Mono',monospace";
const DASH = '—';
const UPLOAD_PATH = '/api/attachments/upload';

interface PendingAttachment {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  meta?: AttachmentMeta;
  errorMsg?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function classifyFileType(file: File): AttachmentMeta['type'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'file';
}

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase().slice(0, 4) : 'FILE';
}

function typeColor(type: AttachmentMeta['type']): { bg: string; fg: string } {
  if (type === 'image') return { bg: '#EEF0FA', fg: '#4655D4' };
  if (type === 'video') return { bg: '#FBF0ED', fg: '#C03D33' };
  return { bg: '#F1F2F5', fg: '#5B6472' };
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
  };

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', UPLOAD_PATH);
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

export function Composer({
  sessionId,
  running,
  backgroundRunning = false,
  turns,
  cost,
  elapsed,
  isDraft = false,
  draftProfile = null,
  projectId = 'general',
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
  projectId?: string;
}): JSX.Element {
  const trpc = useTRPC();
  const L = useVocab();
  const queryClient = useQueryClient();
  const { selectCreatedSession } = useSelectedSession();
  const sendMut = useMutation(trpc.sessions.send.mutationOptions());
  const cancelMut = useMutation(trpc.sessions.cancel.mutationOptions());
  const createAndSendMut = useMutation(
    trpc.sessions.createAndSend.mutationOptions({
      onSuccess: (data) => {
        // Transition from draft to the real session: invalidate the session list so
        // the new session appears, then select it (triggers transcript + live sync).
        // selectCreatedSession marks the id as pending so the chat stays on the new session
        // across the gap before the refetched list contains its row (no flip to the previous
        // most-recent session).
        queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
        selectCreatedSession(data.sessionId);
      },
    }),
  );
  const [composer, setComposer] = useState('');
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

  // ── Slash palette state ──
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashHover, setSlashHover] = useState<number | null>(null);

  // ── Hover states ──
  const [chipHover, setChipHover] = useState(false);
  const [attachHover, setAttachHover] = useState(false);
  const [btnHover, setBtnHover] = useState(false);

  // ── Attachment state ──
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const dragCount = useRef(0);
  const dragFileCount = useRef(0);
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  const hasAttachments = attachments.length > 0;
  const doneAttachments = attachments.filter((a) => a.status === 'done');
  const hasText = !!composer.trim();
  const canSend = (hasText || doneAttachments.length > 0) && (!!sessionId || isDraft) && !sendMut.isPending && !createAndSendMut.isPending;
  const composerBorder = slashOpen ? '#4655D4' : dragOver ? '#4655D4' : '#D9DCE3';
  const composerHint = running ? `${L.pillRunning} · ${L.wbEscToStop}` : `⏎ ${L.wbSend} · ⇧⏎ ${L.wbNewline}`;
  const sendBg = canSend ? '#191C22' : '#D9DCE3';
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
    const ctrl = new AbortController();
    abortControllers.current.set(pending.id, ctrl);

    setAttachments((prev) => prev.map((a) => (a.id === pending.id ? { ...a, status: 'uploading' as const, progress: 0 } : a)));

    uploadFile(
      pending.file,
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
    setAttachments((prev) => prev.filter((a) => a.id !== id));
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
  const doSendText = (raw: string): void => {
    const text = raw.trim();
    const metas = doneAttachments.map((a) => a.meta!);
    if (!text && metas.length === 0) return;

    if (isDraft) {
      // Draft mode: create session + send first message atomically.
      createAndSendMut.mutate({
        projectId,
        profileName: draftProfile ?? undefined,
        text,
        draftUploadId: draftUploadId.current ?? undefined,
        ...(metas.length > 0 ? { attachments: metas } : {}),
      } as any);
    } else {
      if (!sessionId) return;
      sendMut.mutate({
        sessionId,
        text,
        ...(metas.length > 0 ? { attachments: metas } : {}),
      } as any);
    }
    setComposer('');
    setAttachments([]);
    setSlashOpen(false);
    abortControllers.current.forEach((c) => c.abort());
    abortControllers.current.clear();
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  const doSend = (): void => doSendText(composer);

  const doStop = (): void => {
    if (!sessionId || cancelMut.isPending) return;
    cancelMut.mutate({ sessionId });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    } else if (e.key === 'Escape') {
      setSlashOpen(false);
    }
  };

  // ── Render attachment chip ──
  const renderChip = (a: PendingAttachment): JSX.Element => {
    const isImage = a.file.type.startsWith('image/');
    const isVideo = a.file.type.startsWith('video/');
    const type = classifyFileType(a.file);
    const colors = typeColor(type);
    const ext = fileExt(a.file.name);

    if (isImage || isVideo) {
      return (
        <div
          key={a.id}
          style={{
            position: 'relative',
            width: 54,
            height: 54,
            borderRadius: 8,
            border: a.status === 'error' ? '1px solid #C03D33' : '1px solid #E7E9EE',
            background: 'repeating-linear-gradient(45deg,#EDEFF3,#EDEFF3 5px,#E5E8EE 5px,#E5E8EE 10px)',
            flex: 'none',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              position: 'absolute',
              left: 4,
              bottom: 3,
              font: `500 8px ${mono}`,
              color: '#8A93A2',
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
                  color: '#fff',
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
              <span
                style={{
                  position: 'absolute',
                  right: 4,
                  bottom: 3,
                  font: `500 8px ${mono}`,
                  color: '#fff',
                  background: 'rgba(25,28,34,.72)',
                  padding: '1px 4px',
                  borderRadius: 3,
                }}
              >
                0:38
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
                  color: '#4655D4',
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
                  background: '#4655D4',
                }}
              />
            </>
          )}
          {a.status === 'error' && (
            <span
              onClick={() => retryAttachment(a.id)}
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(255,255,255,.75)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                font: `600 8px ${mono}`,
                color: '#C03D33',
              }}
            >
              retry
            </span>
          )}
          {/* Remove button */}
          <span
            onClick={() => removeAttachment(a.id)}
            style={{
              position: 'absolute',
              top: -5,
              right: -5,
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: '#191C22',
              color: '#fff',
              fontSize: 9,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1.5px solid #fff',
              boxSizing: 'border-box',
              cursor: 'pointer',
            }}
          >
            ×
          </span>
        </div>
      );
    }

    // File chip (PDF, CSV, etc.)
    return (
      <div
        key={a.id}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 54,
          border: a.status === 'error' ? '1px solid #C03D33' : '1px solid #E7E9EE',
          background: '#FBFBFC',
          borderRadius: 8,
          padding: '0 12px 0 8px',
          flex: 'none',
          boxSizing: 'border-box',
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
          <span style={{ font: `500 10.5px ${mono}`, color: '#191C22', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.file.name}
          </span>
          <span style={{ font: `400 9px ${mono}`, color: a.status === 'uploading' ? '#4655D4' : a.status === 'error' ? '#C03D33' : '#98A1B0' }}>
            {a.status === 'uploading' ? `${a.progress}%` : a.status === 'error' ? (a.errorMsg || 'Failed') : formatSize(a.file.size)}
          </span>
        </span>
        {/* Remove button */}
        <span
          onClick={() => removeAttachment(a.id)}
          style={{
            position: 'absolute',
            top: -5,
            right: -5,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#191C22',
            color: '#fff',
            fontSize: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1.5px solid #fff',
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
              border: '1px solid #E7E9EE',
              borderRadius: 12,
              boxShadow: '0 6px 24px rgba(16,24,40,.08)',
              background: '#fff',
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
                  background: slashHover === i || i === 0 ? '#EEF0FA' : '#fff',
                  cursor: 'pointer',
                }}
              >
                <span style={{ font: `600 12px ${mono}`, color: i === 0 ? '#4655D4' : '#5B6472' }}>{c.cmd}</span>
                <span style={{ fontSize: 11.5, color: '#8A93A2', marginLeft: 12 }}>{c.desc}</span>
              </div>
            ))}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '7px 14px',
                borderTop: '1px solid #F7F8FA',
                background: '#FBFBFC',
              }}
            >
              <span style={{ font: `400 10px ${mono}`, color: '#B6BDC9' }}>↑↓ {L.wbNavigate} · ⏎ {L.wbRun} · {L.wbEscDismiss}</span>
            </div>
          </div>
        )}

        {/* Running / idle status line */}
        {running ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              font: `500 11px ${mono}`,
              color: '#8A93A2',
              padding: '8px 2px 10px',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                // Amber while a background task holds the session (foreground turn done); accent
                // blue during the live turn itself.
                background: backgroundRunning ? '#D9822B' : '#4655D4',
                animation: 'cxpulse 1.6s ease-in-out infinite',
              }}
            />
            <span>
              {backgroundRunning ? L.pillBackground : L.pillRunning} · {elapsed} · {turnsText}
            </span>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              font: `500 11px ${mono}`,
              color: '#B6BDC9',
              padding: '8px 2px 10px',
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#D9DCE3' }} />
            <span>
              {hasRun ? `${L.wbIdle} · ${elapsed} · ${turnsText} · ${costText}` : L.wbIdle}
            </span>
          </div>
        )}

        {/* Composer card — doubles as drop zone (15a) */}
        <div
          style={{
            position: 'relative',
            border: dragOver ? '1.5px dashed #4655D4' : '1.5px solid ' + composerBorder,
            borderRadius: 12,
            background: dragOver ? '#FBFBFE' : '#fff',
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
              <span style={{ font: `600 11.5px ${mono}`, color: '#4655D4' }}>
                {dragFileCount.current > 0
                  ? L.wbDropFilesPlural.replace('{n}', String(dragFileCount.current))
                  : L.wbDropFilesSingular}
              </span>
              <span style={{ font: `400 10px ${mono}`, color: '#98A1B0' }}>
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
                          borderBottom: '1px solid #EFF1F5',
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
                        setSlashOpen(v.startsWith('/'));
                        autoGrow(e.target);
                      }}
                      onKeyDown={onKey}
                      onPaste={onPaste}
                      placeholder={hasAttachments ? L.wbAttachPlaceholder : L.composerPh}
                      style={{
                        width: '100%',
                        fontSize: 13.5,
                        lineHeight: 1.5,
                        color: '#191C22',
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
                          border: '1px solid ' + (attachHover ? '#C9CFF2' : '#E7E9EE'),
                          color: attachHover ? '#4655D4' : '#8A93A2',
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
                          border: '1px solid ' + (chipHover ? '#C9CFF2' : '#E7E9EE'),
                          color: chipHover ? '#4655D4' : '#8A93A2',
                          padding: '2px 7px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          marginLeft: 8,
                        }}
                      >
                        / {L.commands}
                      </span>

                      <span style={{ marginLeft: 'auto', font: `400 10.5px ${mono}`, color: '#B6BDC9' }}>
                        {hasAttachments ? L.wbAttachHint : composerHint}
                      </span>
                    </div>
                  </div>

                  {/* Send / Stop button */}
                  {running ? (
                    <div
                      title={`${L.stop} · esc`}
                      onClick={doStop}
                      onMouseEnter={() => setBtnHover(true)}
                      onMouseLeave={() => setBtnHover(false)}
                      style={{
                        flex: 'none',
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        background: btnHover ? '#32363E' : '#191C22',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: cancelMut.isPending ? 'default' : 'pointer',
                        marginTop: hasAttachments ? 2 : 0,
                      }}
                    >
                      <span style={{ width: 11, height: 11, background: '#fff', borderRadius: 2 }} />
                    </div>
                  ) : (
                    <div
                      data-action="send"
                      onClick={doSend}
                      style={{
                        flex: 'none',
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        background: sendBg,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: canSend ? 'pointer' : 'default',
                        marginTop: hasAttachments ? 2 : 0,
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#fff" strokeWidth="1.8">
                        <path d="M7 12V2M3 6l4-4 4 4" />
                      </svg>
                    </div>
                  )}
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
                    border: '1px solid #C9CFF2',
                    borderRadius: 10,
                    padding: '10px 18px',
                    boxShadow: '0 2px 8px rgba(70,85,212,.10)',
                    zIndex: 2,
                  }}
                >
                  <span style={{ font: `600 11.5px ${mono}`, color: '#4655D4' }}>
                    {dragFileCount.current > 0
                      ? L.wbDropAddMoreN.replace('{n}', String(dragFileCount.current))
                      : L.wbDropAddMore}
                  </span>
                  <span style={{ font: `400 10px ${mono}`, color: '#98A1B0' }}>
                    {L.wbDragOverCount.replace('{n}', String(attachments.length)).replace('{m}', String(attachments.length + dragFileCount.current))}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

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
