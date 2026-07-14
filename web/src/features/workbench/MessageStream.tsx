import { useEffect, useRef } from 'react';
import { useVocab } from '@/i18n';
import type { ChatRow } from './transcript-vm';
import { ToolCallsRow } from './ToolCallsRow';
import { ChatMarkdown } from './ChatMarkdown';
import type { AttachmentMeta } from './chat-content';

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
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function AssistantBlock({ text, streaming: _streaming }: { text: string; streaming: boolean }): JSX.Element {
  return (
    <div style={{ animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both', fontSize: 14, lineHeight: 1.65, color: '#22262E', minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
      <ChatMarkdown text={text} />
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
      return <AssistantBlock text={row.text} streaming={row.streaming} />;
    default:
      return null;
  }
}

export function MessageStream({ rows, loading }: { rows: ChatRow[]; loading: boolean }): JSX.Element {
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
  }, [rows, loading]);

  return (
    <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      <div style={{ width: '100%', maxWidth: 720, margin: '0 auto', padding: '22px 32px 12px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!populated && !loading && <EmptyChat />}
        {rows.map((row, i) => (
          <Row key={i} row={row} />
        ))}
      </div>
    </div>
  );
}
