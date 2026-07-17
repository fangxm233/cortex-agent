import { useEffect, useRef, useState } from 'react';
import { useVocab } from '@/i18n';
import type { ChatRow, Attachment } from './transcript-vm';
import { ToolCallsRow } from './ToolCallsRow';
import { ChatMarkdown } from './ChatMarkdown';
import type { AttachmentMeta } from './chat-content';
import { downloadFile, openFile, copyFilePath, fetchFileObjectUrl } from '@/lib/files';

// Message stream — 1:1 from prototype.dc.html L131–357. The transcript body (divider / user bubble /
// tool-call row / assistant text) is driven by REAL data (task aba0): the `rows` are built from the
// real `sessions.transcript` query + live `session.message` stream by the pure transcript-vm; the
// last assistant row streams a caret while output is live. Assistant text renders as Markdown.
// The stream sticks to the bottom while new content lands, but releases when the user scrolls up
// (and re-pins once they scroll back to the bottom).

const mono = "'IBM Plex Mono',monospace";

function Divider({ text }: { text: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1, height: 1, background: '#EFF1F5' }} />
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: '#B6BDC9' }}>{text}</div>
      <div style={{ flex: 1, height: 1, background: '#EFF1F5' }} />
    </div>
  );
}

function typeColor(type: AttachmentMeta['type']): { bg: string; fg: string } {
  if (type === 'image') return { bg: '#EEF0FA', fg: '#4655D4' };
  if (type === 'video') return { bg: '#FBF0ED', fg: '#C03D33' };
  return { bg: '#F1F2F5', fg: '#5B6472' };
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

/** Renders a single attachment thumbnail / file card for the message bubble (15a). */
function AttachmentCard({ a }: { a: AttachmentMeta }): JSX.Element {
  if (a.type === 'image') {
    return (
      <div
        style={{
          position: 'relative',
          width: 150,
          height: 98,
          borderRadius: 12,
          border: '1px solid #E7E9EE',
          background: 'repeating-linear-gradient(45deg,#EDEFF3,#EDEFF3 5px,#E5E8EE 5px,#E5E8EE 10px)',
          boxSizing: 'border-box',
          flex: 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 6,
            bottom: 5,
            font: `500 8.5px 'IBM Plex Mono',monospace`,
            color: '#8A93A2',
            background: 'rgba(255,255,255,.88)',
            padding: '1.5px 5px',
            borderRadius: 4,
          }}
        >
          {a.name}
        </span>
      </div>
    );
  }

  if (a.type === 'video') {
    return (
      <div
        style={{
          position: 'relative',
          width: 150,
          height: 98,
          borderRadius: 12,
          border: '1px solid #E7E9EE',
          background: 'repeating-linear-gradient(45deg,#EDEFF3,#EDEFF3 5px,#E5E8EE 5px,#E5E8EE 10px)',
          boxSizing: 'border-box',
          flex: 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%,-50%)',
            width: 26,
            height: 26,
            borderRadius: '50%',
            background: 'rgba(25,28,34,.82)',
            color: '#fff',
            fontSize: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            paddingLeft: 2,
            boxSizing: 'border-box',
          }}
        >
          ▶
        </span>
        <span
          style={{
            position: 'absolute',
            right: 6,
            bottom: 5,
            font: `500 8.5px 'IBM Plex Mono',monospace`,
            color: '#fff',
            background: 'rgba(25,28,34,.72)',
            padding: '1.5px 5px',
            borderRadius: 4,
          }}
        >
          0:38
        </span>
      </div>
    );
  }

  // File card
  const colors = typeColor(a.type);
  const ext = fileExt(a.name);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        background: '#F1F2F5',
        borderRadius: 10,
        padding: '8px 12px 8px 9px',
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
          font: `700 8px 'IBM Plex Mono',monospace`,
          flex: 'none',
        }}
      >
        {ext}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ font: `500 11px 'IBM Plex Mono',monospace`, color: '#191C22' }}>{a.name}</span>
        <span style={{ font: `400 9px 'IBM Plex Mono',monospace`, color: '#98A1B0' }}>
          {formatSize(a.size)} · {a.path}
        </span>
      </span>
    </div>
  );
}

// ── Agent-sent files (20a) — left-aligned white-bordered cards, mirror of the user's gray cards ──

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : p;
}

/** Small square hover-action button (download / copy path). */
function ActionBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <span
      role="button"
      title={title}
      onClick={onClick}
      style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid #E7E9EE', background: '#FBFBFC', color: '#5B6472', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, cursor: 'pointer', flex: 'none' }}
    >
      {children}
    </span>
  );
}

/** "open ↗" hover-action pill. */
function OpenBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <span
      role="button"
      onClick={onClick}
      style={{ height: 26, borderRadius: 7, border: '1px solid #C9CFF2', background: '#FBFBFE', color: '#4655D4', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `500 9.5px ${mono}`, padding: '0 9px', cursor: 'pointer', flex: 'none' }}
    >
      {children} ↗
    </span>
  );
}

/** 20a default/hover file card — white bordered; hover reveals download / copy-path / open. */
function AgentFileCard({ a }: { a: Attachment }): JSX.Element {
  const L = useVocab();
  const colors = typeColor(a.type);
  const ext = fileExt(a.name);
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        border: '1px solid #E7E9EE', background: '#fff',
        borderRadius: 10, padding: '9px 10px',
        boxShadow: '0 1px 2px rgba(16,24,40,.03)',
        boxSizing: 'border-box', maxWidth: '100%',
      }}
    >
      <span style={{ width: 28, height: 34, borderRadius: 5, background: colors.bg, color: colors.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', font: `700 8px ${mono}`, flex: 'none' }}>{ext}</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{ font: `500 11.5px ${mono}`, color: '#191C22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
        <span style={{ font: `400 9px ${mono}`, color: '#98A1B0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatSize(a.size)} · {dirOf(a.path)}</span>
      </span>
      {/* Actions are always visible (no hover toggle) so download / copy-path / open are one click away. */}
      <span style={{ display: 'flex', gap: 5, flex: 'none' }}>
        <ActionBtn title={L.wbFileDownload} onClick={() => void downloadFile(a.path, a.name)}>↓</ActionBtn>
        <ActionBtn title={L.wbFileCopyPath} onClick={() => void copyFilePath(a.path)}>⧉</ActionBtn>
        <OpenBtn onClick={() => void openFile(a.path)}>{L.wbFileOpen}</OpenBtn>
      </span>
    </div>
  );
}

/** 20a image — real inline preview (≤320px) fetched with auth into an object URL; hover download. */
function AgentImagePreview({ a }: { a: Attachment }): JSX.Element {
  const L = useVocab();
  const [url, setUrl] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    fetchFileObjectUrl(a.path, 'inline').then((u) => { if (alive) { created = u; setUrl(u); } }).catch(() => {});
    return () => { alive = false; if (created) URL.revokeObjectURL(created); };
  }, [a.path]);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', maxWidth: 320, borderRadius: 12, border: '1px solid #E7E9EE',
        overflow: 'hidden', boxSizing: 'border-box',
        background: url ? '#fff' : 'repeating-linear-gradient(45deg,#EDEFF3,#EDEFF3 5px,#E5E8EE 5px,#E5E8EE 10px)',
      }}
    >
      {url ? (
        <img src={url} alt={a.name} style={{ display: 'block', maxWidth: 320, maxHeight: 240, width: 'auto', height: 'auto' }} />
      ) : (
        <div style={{ width: 320, height: 180 }} />
      )}
      <span style={{ position: 'absolute', left: 8, bottom: 7, font: `500 8.5px ${mono}`, color: '#8A93A2', background: 'rgba(255,255,255,.88)', padding: '1.5px 5px', borderRadius: 4 }}>{a.name}</span>
      {hover && (
        <span
          role="button"
          title={L.wbFileDownload}
          onClick={() => void downloadFile(a.path, a.name)}
          style={{ position: 'absolute', top: 7, right: 7, width: 24, height: 24, borderRadius: 7, background: 'rgba(25,28,34,.78)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, cursor: 'pointer' }}
        >
          ↓
        </span>
      )}
    </div>
  );
}

/** 20a file group — hung under the agent text, left-aligned, ≤75% width. Images inline first, then
 *  file cards; a "download all" affordance appears for groups of ≥3. */
function AgentFileGroup({ attachments }: { attachments: Attachment[] }): JSX.Element {
  const L = useVocab();
  const images = attachments.filter((a) => a.type === 'image');
  const files = attachments.filter((a) => a.type !== 'image');
  return (
    <div style={{ maxWidth: '75%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, marginTop: 10 }}>
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {images.map((a, i) => <AgentImagePreview key={`img-${i}`} a={a} />)}
        </div>
      )}
      {files.map((a, i) => <AgentFileCard key={`file-${i}`} a={a} />)}
      {attachments.length >= 3 && (
        <div style={{ font: `400 9.5px ${mono}`, color: '#B6BDC9', padding: '2px 2px 0' }}>
          {attachments.length} {L.wbFileFiles} ·{' '}
          <span style={{ color: '#8A93A2', cursor: 'pointer' }} onClick={() => attachments.forEach((a) => void downloadFile(a.path, a.name))}>
            {L.wbFileDownloadAll} ↓
          </span>
        </div>
      )}
    </div>
  );
}

function UserBubble({ text, attachments }: { text: string; attachments?: AttachmentMeta[] }): JSX.Element {
  const hasAttachments = attachments && attachments.length > 0;
  return (
    <div
      style={{
        alignSelf: 'flex-end',
        maxWidth: '75%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
        animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both',
      }}
    >
      {/* Attachments above the bubble */}
      {hasAttachments && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {attachments!.map((a, i) => (
            <AttachmentCard key={i} a={a} />
          ))}
        </div>
      )}
      {/* Text bubble */}
      {text && (
        <div
          style={{
            background: '#F1F2F5',
            borderRadius: '14px 14px 4px 14px',
            padding: '9px 14px',
            fontSize: 13.5,
            lineHeight: 1.55,
            color: '#191C22',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function AssistantBlock({ text, streaming: _streaming, attachments }: { text: string; streaming: boolean; attachments?: Attachment[] }): JSX.Element {
  const hasAttachments = !!attachments && attachments.length > 0;
  return (
    <div style={{ animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both', fontSize: 14, lineHeight: 1.65, color: '#22262E', minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
      {text.trim() && <ChatMarkdown text={text} />}
      {hasAttachments && <AgentFileGroup attachments={attachments!} />}
    </div>
  );
}

// Empty session — 1:1 from prototype.dc.html L133–143 (chatEmpty). EN copy verbatim from support.js.
function EmptyChat(): JSX.Element {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 13, padding: '88px 20px 40px', textAlign: 'center' }}>
      <div style={{ width: 40, height: 40, borderRadius: 12, background: '#191C22', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `600 15px ${mono}` }}>cx</div>
      <div style={{ fontSize: 15, fontWeight: 650, color: '#191C22' }}>{L.wbEmptyTitle}</div>
      <div style={{ fontSize: 12, color: '#8A93A2', lineHeight: 1.7, maxWidth: 420 }}>
        {L.wbEmptyBody}
      </div>
      <div style={{ fontSize: 10.5, color: '#B6BDC9', lineHeight: 1.7, maxWidth: 430 }}>
        {L.wbEmptyHint}
      </div>
    </div>
  );
}

function Row({ row }: { row: ChatRow }): JSX.Element | null {
  switch (row.kind) {
    case 'divider':
      return <Divider text={row.text} />;
    case 'user':
      return <UserBubble text={row.text} attachments={row.attachments} />;
    case 'tools':
      return <ToolCallsRow calls={row.calls.map((c) => ({ label: c.kind, kind: c.kind, input: c.input }))} />;
    case 'assistant':
      return <AssistantBlock text={row.text} streaming={row.streaming} attachments={row.attachments} />;
    default:
      return null;
  }
}

/** Presentational transcript column — the ordered chat rows (divider / user / tools / assistant) laid
 *  out vertically. Framework-free of the scroll/stick behavior so it can be embedded wherever a
 *  transcript needs rendering (the workbench center chat, the thread-detail step chat). */
export function ChatRows({ rows }: { rows: ChatRow[] }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {rows.map((row, i) => (
        <Row key={i} row={row} />
      ))}
    </div>
  );
}

export function MessageStream({ rows, loading, inlineThreadCard, interactionsSlot }: { rows: ChatRow[]; loading: boolean; inlineThreadCard?: React.ReactNode; interactionsSlot?: React.ReactNode }): JSX.Element {
  const populated = rows.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is currently pinned to the bottom. Starts pinned; a user scroll-up releases it,
  // scrolling back to the bottom re-pins it.
  const stickRef = useRef(true);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distanceFromBottom < 40;
  };

  // After every content change, keep the view pinned to the bottom IF the user hasn't scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rows, loading, interactionsSlot]);

  return (
    <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      <div style={{ width: '100%', maxWidth: 756, margin: '0 auto', padding: '22px 32px 12px' }}>
        {!populated && !loading && <EmptyChat />}
        <ChatRows rows={rows} />
        {inlineThreadCard && <div style={{ marginTop: 16 }}>{inlineThreadCard}</div>}
        {interactionsSlot && <div style={{ marginTop: 16 }}>{interactionsSlot}</div>}
      </div>
    </div>
  );
}
