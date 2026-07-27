// input:  desktop ChatRows with notices, DEBUG details, interactions, and edits
// output: scroll-stable transcript with semantic notices and message inspectors
// pos:    Desktop workbench message presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useRef, useState } from 'react';
import { useLang, useVocab } from '@/i18n';
import type { ChatRow, Attachment } from './transcript-vm';
import { ToolCallsRow } from './ToolCallsRow';
import { ChatMarkdown } from './ChatMarkdown';
import type { AttachmentMeta } from './chat-content';
import { useDownloadFile } from '@/features/media/useDownloadFile';
import { useMediaViewer } from '@/features/media/MediaViewer';
import { useDocViewer } from '@/features/media/DocViewer';
import { useWorkspaceObjectUrl } from '@/features/media/useWorkspaceObjectUrl';
import { mediaKindOf } from '@/features/media/media-kind';
import { VideoThumb } from '@/features/media/VideoThumb';
import { docKindOf } from '@/features/media/doc-kind';
import { interactionView, emptyDeskAsk, type DeskAskState } from './interaction-vm';
import type { InteractionActions } from './useInteractionActions';
import { DeskAskCard, DeskPlanCard, D_INT_COPY } from './InteractionCards';
import { PlanReadOverlay } from './PlanReadOverlay';
import { rewindStats, regenNoteIndexes } from './transcript-vm';
import { useRevealedText } from './useRevealedText';
import { DebugDetailsModal, DebugInspectButton, type DebugDetail } from './DebugDetailsModal';
import { M_EDIT_COPY, HoverActionPill, EditBox, RewindNote, RewindTail, EditedBadge, RegenNote, type MEditCopy } from './MessageEdit';
import { ChatNotice } from './ChatNotice';

/** Edit+rewind context passed from CenterChat (sessions.rewind). Absent → chat is read-only
 *  w.r.t. editing (the thread step chat), hover copy still works. */
export interface MessageEditCtx {
  /** Live turn on the session — editing is greyed out (运行中不可编辑). */
  running: boolean;
  /** A rewind mutation is in flight. */
  busy: boolean;
  onSubmit: (turnIndex: number, text: string) => void;
}

// Message stream — 1:1 from prototype.dc.html L131–357. The transcript body (divider / user bubble /
// tool-call row / assistant text) is driven by REAL data (task aba0): the `rows` are built from the
// real `sessions.transcript` query + live `session.message` stream by the pure transcript-vm. A
// reply still being written grows in place with no caret; a mid-turn message the model has not read
// yet trails the stream with dimmed text. Assistant text renders as Markdown.
// The stream sticks to the bottom while new content lands, but releases when the user scrolls up
// (and re-pins once they scroll back to the bottom).
//
// The row still being written (`preview`) is revealed at a steady character rate rather than a delta
// at a time — the deltas arrive about a line at a time, which reads as a staircase instead of as
// writing. The pacing rule is pure (`reveal-pacing`) and its frame loop is shared with the mobile
// chat (`useRevealedText`); the rAF state lives in the assistant block that draws it, so a per-frame
// update re-renders ONE row and never the transcript. Everything already in
// the buffer is on its way to the screen, so nothing is predicted: the drawn string is always a
// prefix of what arrived. Settling needs no special case — the paced text and the committed text
// share one component instance, so the row simply stops being a preview when the authoritative
// message lands (or the turn ends, or a rewind arrives) and is drawn whole on that render, with no
// remount that would replay the block's entry fade.

const mono = "'IBM Plex Mono',monospace";

function Divider({ text }: { text: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line-2)' }} />
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: 'var(--proto-faint)' }}>{text}</div>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line-2)' }} />
    </div>
  );
}

function typeColor(type: AttachmentMeta['type']): { bg: string; fg: string } {
  if (type === 'image') return { bg: 'var(--proto-accent-bg)', fg: 'var(--proto-accent)' };
  if (type === 'video') return { bg: 'var(--proto-danger-bg)', fg: 'var(--proto-danger)' };
  return { bg: 'var(--proto-gray)', fg: 'var(--proto-muted)' };
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

/** Real thumbnail (image/video) that opens the media lightbox on click — used by the sent-user-message
 *  bubble (15a). The bytes are auth-fetched into an object URL (a plain <img>/<video src> can't send
 *  the token). Clicking raises the in-app modal (no new tab). */
function MediaThumb({ a, width, height }: { a: { name: string; path: string; type: 'image' | 'video' | 'file' }; width: number; height: number }): JSX.Element {
  const kind = mediaKindOf(a.type)!;
  const { openMedia } = useMediaViewer();
  const url = useWorkspaceObjectUrl(a.path);
  return (
    <div
      role="button"
      title={a.name}
      onClick={() => openMedia({ kind, name: a.name, path: a.path })}
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: 12,
        border: '1px solid var(--proto-line)',
        background: url ? '#000' : 'repeating-linear-gradient(45deg,var(--proto-line),var(--proto-line) 5px,var(--proto-line) 5px,var(--proto-line) 10px)',
        boxSizing: 'border-box',
        flex: 'none',
        overflow: 'hidden',
        cursor: 'pointer',
      }}
    >
      {url && kind === 'image' && (
        <img src={url} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      )}
      {url && kind === 'video' && (
        <VideoThumb src={url} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      )}
      {kind === 'video' && (
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
            color: 'var(--ink-solid-fg)',
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
      )}
      <span
        style={{
          position: 'absolute',
          left: 6,
          bottom: 5,
          maxWidth: width - 12,
          font: `500 8.5px 'IBM Plex Mono',monospace`,
          color: 'var(--proto-muted-2)',
          background: 'rgba(255,255,255,.88)',
          padding: '1.5px 5px',
          borderRadius: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          boxSizing: 'border-box',
        }}
      >
        {a.name}
      </span>
    </div>
  );
}

/** Renders a single attachment thumbnail / file card for the message bubble (15a). */
function AttachmentCard({ a }: { a: AttachmentMeta }): JSX.Element {
  if (a.type === 'image' || a.type === 'video') {
    return <MediaThumb a={a} width={150} height={98} />;
  }

  // File card — PDF/text open the in-app DocViewer on click (mirrors the agent file card); other
  // files stay inert (opening in a new tab is a no-op in the native WebView).
  const colors = typeColor(a.type);
  const ext = fileExt(a.name);
  const { openDoc } = useDocViewer();
  const docKind = docKindOf(a.name, a.mimeType);
  const preview = docKind ? () => openDoc({ kind: docKind, name: a.name, path: a.path, mimeType: a.mimeType }) : undefined;
  return (
    <div
      role={preview ? 'button' : undefined}
      title={preview ? a.name : undefined}
      onClick={preview}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        background: 'var(--proto-gray)',
        borderRadius: 10,
        padding: '8px 12px 8px 9px',
        cursor: preview ? 'pointer' : 'default',
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
        <span style={{ font: `500 11px 'IBM Plex Mono',monospace`, color: 'var(--proto-ink)' }}>{a.name}</span>
        <span style={{ font: `400 9px 'IBM Plex Mono',monospace`, color: 'var(--proto-muted-3)' }}>
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
      style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid var(--proto-line)', background: 'var(--proto-rail)', color: 'var(--proto-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, cursor: 'pointer', flex: 'none' }}
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
      style={{ height: 26, borderRadius: 7, border: '1px solid var(--proto-accent-border)', background: 'var(--proto-rail)', color: 'var(--proto-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `500 9.5px ${mono}`, padding: '0 9px', cursor: 'pointer', flex: 'none' }}
    >
      {children} ↗
    </span>
  );
}

/** 20a file card — white bordered; download / copy-path always visible. PDF/text files are clickable
 *  and reveal a "预览" action that opens the in-app DocViewer; other files only download (opening a
 *  file in a new tab is a no-op in the native shell, so that broken affordance was removed). */
function AgentFileCard({ a }: { a: Attachment }): JSX.Element {
  const L = useVocab();
  const dl = useDownloadFile();
  const { openDoc } = useDocViewer();
  const colors = typeColor(a.type);
  const ext = fileExt(a.name);
  const docKind = docKindOf(a.name, a.mimeType);
  const preview = docKind ? () => openDoc({ kind: docKind, name: a.name, path: a.path, mimeType: a.mimeType }) : undefined;
  return (
    <div
      role={preview ? 'button' : undefined}
      onClick={preview}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        border: '1px solid var(--proto-line)', background: 'var(--proto-card)',
        borderRadius: 10, padding: '9px 10px',
        boxShadow: '0 1px 2px rgba(16,24,40,.03)',
        boxSizing: 'border-box', maxWidth: '100%',
        cursor: preview ? 'pointer' : 'default',
      }}
    >
      <span style={{ width: 28, height: 34, borderRadius: 5, background: colors.bg, color: colors.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', font: `700 8px ${mono}`, flex: 'none' }}>{ext}</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{ font: `500 11.5px ${mono}`, color: 'var(--proto-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
        <span style={{ font: `400 9px ${mono}`, color: 'var(--proto-muted-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatSize(a.size)} · {dirOf(a.path)}</span>
      </span>
      {/* Actions stop propagation so they don't also trigger the card's preview click. */}
      <span style={{ display: 'flex', gap: 5, flex: 'none' }} onClick={(e) => e.stopPropagation()}>
        <ActionBtn title={L.wbFileDownload} onClick={() => dl(a.path, a.name)}>↓</ActionBtn>
        {preview && <OpenBtn onClick={preview}>{L.wbFileOpen}</OpenBtn>}
      </span>
    </div>
  );
}

/** 20a image/video — real inline preview (≤320px) fetched with auth into an object URL; click opens
 *  the media lightbox (no new tab), hover reveals a download button. */
function AgentMediaPreview({ a }: { a: Attachment }): JSX.Element {
  const L = useVocab();
  const dl = useDownloadFile();
  const kind = mediaKindOf(a.type)!;
  const { openMedia } = useMediaViewer();
  const url = useWorkspaceObjectUrl(a.path);
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      title={a.name}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => openMedia({ kind, name: a.name, path: a.path })}
      style={{
        position: 'relative', maxWidth: 320, borderRadius: 12, border: '1px solid var(--proto-line)',
        overflow: 'hidden', boxSizing: 'border-box', cursor: 'pointer',
        background: url ? '#000' : 'repeating-linear-gradient(45deg,var(--proto-line),var(--proto-line) 5px,var(--proto-line) 5px,var(--proto-line) 10px)',
      }}
    >
      {url && kind === 'image' && (
        <img src={url} alt={a.name} style={{ display: 'block', maxWidth: 320, maxHeight: 240, width: 'auto', height: 'auto' }} />
      )}
      {url && kind === 'video' && (
        <VideoThumb src={url} style={{ display: 'block', maxWidth: 320, maxHeight: 240, width: 'auto', height: 'auto' }} />
      )}
      {!url && <div style={{ width: 320, height: 180 }} />}
      {kind === 'video' && (
        <span
          style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 40, height: 40, borderRadius: '50%', background: 'rgba(25,28,34,.72)', color: 'var(--ink-solid-fg)', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 3, boxSizing: 'border-box' }}
        >
          ▶
        </span>
      )}
      <span style={{ position: 'absolute', left: 8, bottom: 7, font: `500 8.5px ${mono}`, color: 'var(--proto-muted-2)', background: 'rgba(255,255,255,.88)', padding: '1.5px 5px', borderRadius: 4 }}>{a.name}</span>
      {hover && (
        <span
          role="button"
          title={L.wbFileDownload}
          onClick={(e) => { e.stopPropagation(); dl(a.path, a.name); }}
          style={{ position: 'absolute', top: 7, right: 7, width: 24, height: 24, borderRadius: 7, background: 'rgba(25,28,34,.78)', color: 'var(--ink-solid-fg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, cursor: 'pointer' }}
        >
          ↓
        </span>
      )}
    </div>
  );
}

/** 20a file group — hung under the agent text, left-aligned, ≤75% width. Images/videos inline first
 *  (click → lightbox), then plain file cards; a "download all" affordance appears for groups of ≥3. */
function AgentFileGroup({ attachments }: { attachments: Attachment[] }): JSX.Element {
  const L = useVocab();
  const dl = useDownloadFile();
  const media = attachments.filter((a) => mediaKindOf(a.type) !== null);
  const files = attachments.filter((a) => mediaKindOf(a.type) === null);
  return (
    <div style={{ maxWidth: '75%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, marginTop: 10 }}>
      {media.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {media.map((a, i) => <AgentMediaPreview key={`media-${i}`} a={a} />)}
        </div>
      )}
      {files.map((a, i) => <AgentFileCard key={`file-${i}`} a={a} />)}
      {attachments.length >= 3 && (
        <div style={{ font: `400 9.5px ${mono}`, color: 'var(--proto-faint)', padding: '2px 2px 0' }}>
          {attachments.length} {L.wbFileFiles} ·{' '}
          <span style={{ color: 'var(--proto-muted-2)', cursor: 'pointer' }} onClick={() => attachments.forEach((a) => dl(a.path, a.name))}>
            {L.wbFileDownloadAll} ↓
          </span>
        </div>
      )}
    </div>
  );
}

function UserBubble({ text, attachments, ts, edited, editCopy, onStartEdit, editDisabled, pending, debug }: {
  text: string;
  attachments?: AttachmentMeta[];
  ts?: string;
  edited?: { originalText: string; originalTs: string };
  /** Present → the sec-23 hover copy/edit affordances render. */
  editCopy?: MEditCopy;
  /** Present → the pill carries the edit button (rewind-capable rows only). */
  onStartEdit?: () => void;
  editDisabled?: boolean;
  /** Written to the backend but not yet read by the model. Only the TEXT dims — the bubble keeps
   *  its background and full opacity, and nothing else marks the state. The row is provisional, not
   *  disabled or failing, and an icon/spinner/label would read as either. */
  pending?: boolean;
  /** Present only when the server returned DEBUG-gated exact adapter input. */
  debug?: { agentMessage: string };
}): JSX.Element {
  const hasAttachments = attachments && attachments.length > 0;
  const [hover, setHover] = useState(false);
  const [debugDetail, setDebugDetail] = useState<DebugDetail | null>(null);
  return (
    <div
      className="group"
      onMouseEnter={editCopy ? () => setHover(true) : undefined}
      onMouseLeave={editCopy ? () => setHover(false) : undefined}
      style={{
        position: 'relative',
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
      {/* Text bubble — hover floats the copy/edit pill to its left (sec-23: 不遮内容).
          The pill is absolutely positioned so it never consumes the bubble's width. */}
      {text && (
        <div style={{ position: 'relative', display: 'flex', justifyContent: 'flex-end', maxWidth: '100%' }}>
          {editCopy && hover && (
            <div style={{ position: 'absolute', right: '100%', top: '50%', transform: 'translateY(-50%)', paddingRight: 8, display: 'flex' }}>
              <HoverActionPill text={text} copy={editCopy} onEdit={onStartEdit} editDisabled={editDisabled} />
            </div>
          )}
          <div
            style={{
              background: 'var(--proto-gray)',
              borderRadius: '14px 14px 4px 14px',
              padding: '9px 14px',
              fontSize: 13.5,
              lineHeight: 1.55,
              color: pending ? 'var(--proto-muted)' : 'var(--proto-ink)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'break-word',
              wordBreak: 'break-word',
              minWidth: 0,
            }}
          >
            {text}
          </div>
        </div>
      )}
      {debug ? (
        <div style={{ position: 'absolute', left: '100%', top: '50%', transform: 'translateY(-50%)', paddingLeft: 8, display: 'flex' }}>
          <DebugInspectButton onClick={(event) => { event.stopPropagation(); setDebugDetail({ kind: 'user', agentMessage: debug.agentMessage }); }} />
        </div>
      ) : null}
      <DebugDetailsModal detail={debugDetail} onClose={() => setDebugDetail(null)} />
      {/* 已编辑 badge + hover original card (sec-23 right column) */}
      {editCopy && edited && <EditedBadge edited={edited} ts={ts} copy={editCopy} />}
    </div>
  );
}

function AssistantBlock({ text, attachments, editCopy, regen, preview, streamKey }: {
  text: string;
  attachments?: Attachment[];
  /** Present → the「由编辑重新生成」footnote renders (agent messages carry no copy affordance). */
  editCopy?: MEditCopy;
  /** True → the「由编辑重新生成」footnote renders atop this block. */
  regen?: boolean;
  /** True → this is the block being written right now, so its text is revealed at a steady rate. */
  preview?: boolean;
  /** Identity of the stream the preview belongs to (the session) — a change settles the reveal. */
  streamKey?: string;
}): JSX.Element {
  const hasAttachments = !!attachments && attachments.length > 0;
  const shown = useRevealedText(text, !!preview, streamKey);
  return (
    <div
      style={{ position: 'relative', animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both', fontSize: 14, lineHeight: 1.65, color: 'var(--proto-ink-2)', minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word' }}
    >
      {editCopy && regen && <div style={{ marginBottom: 4 }}><RegenNote copy={editCopy} /></div>}
      {/* Token-level streaming carries NO caret here: the text visibly extends itself and the
          composer already reports the running turn, so a blinking block only adds noise. The
          mobile stream keeps its own caret (smaller viewport, no persistent status line). */}
      {shown.trim() && <ChatMarkdown text={shown} />}
      {hasAttachments && <AgentFileGroup attachments={attachments!} />}
    </div>
  );
}

// Empty session — 1:1 from prototype.dc.html L133–143 (chatEmpty). EN copy verbatim from support.js.
function EmptyChat(): JSX.Element {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 13, padding: '88px 20px 40px', textAlign: 'center' }}>
      <div aria-label="Cortex" style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--brand-badge-bg)', border: '1px solid var(--brand-badge-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* 25c 皮层弧 C (scheme.dc.html §25c) — follows theme */}
        <svg width={28} height={28} viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <circle cx={33} cy={32} r={5} fill="var(--brand-badge-core)" />
          <path d="M42.29 23.64A12.5 12.5 0 1 0 42.29 40.36" stroke="var(--brand-badge-arc)" strokeWidth={5} strokeLinecap="round" />
          <path d="M48.6 17.95A21 21 0 1 0 48.6 46.05" stroke="var(--brand-badge-arc)" strokeWidth={5} strokeLinecap="round" />
        </svg>
      </div>
      <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.wbEmptyTitle}</div>
      <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', lineHeight: 1.7, maxWidth: 420 }}>
        {L.wbEmptyBody}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', lineHeight: 1.7, maxWidth: 430 }}>
        {L.wbEmptyHint}
      </div>
    </div>
  );
}

/** One-line summary row for resolved / expired / cancelled interactions (and legacy rows). */
function InteractionSummaryRow({ tone, label, text }: { tone: 'done' | 'rejected' | 'inactive'; label: string; text: string }): JSX.Element {
  const color = tone === 'rejected' ? 'var(--proto-danger)' : tone === 'inactive' ? 'var(--proto-muted-3)' : 'var(--proto-success)';
  const icon = tone === 'rejected' ? '✗' : tone === 'inactive' ? '◌' : '✓';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--proto-rail)', border: '1px solid var(--proto-line-2)', borderRadius: 10, opacity: tone === 'inactive' ? 0.6 : 0.85 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color, flexShrink: 0 }}>{icon} {label}</span>
      <span style={{ fontSize: 12, color: 'var(--proto-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
    </div>
  );
}

/** Interaction row — the transcript-inline card (scheme 13b/13c). Entity rows render the full
 *  desktop cards (pending actionable · resolved sealed in place); expired/cancelled + legacy rows
 *  render one-line summaries. The row owns the 13b answer state, the 13c 请求修改 expansion and
 *  the reading overlay (阅读 › / 查看计划 ›). */
export function InteractionRowCard({ row, actions }: {
  row: Extract<ChatRow, { kind: 'interaction' }>;
  actions?: InteractionActions;
}): JSX.Element {
  const lang = useLang();
  const copy = lang === 'zh' ? D_INT_COPY.zh : D_INT_COPY.en;
  const [askState, setAskState] = useState<DeskAskState>(emptyDeskAsk);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
  const v = interactionView(row);

  if (v.kind === 'ask') {
    const m = v.model;
    return (
      <DeskAskCard
        model={m}
        state={askState}
        copy={copy}
        onState={setAskState}
        onSubmit={(answers) => actions?.answerQuestion(m.requestId, answers)}
        busy={!!actions?.busy}
      />
    );
  }
  if (v.kind === 'plan') {
    const m = v.model;
    return (
      <>
        <DeskPlanCard
          model={m}
          copy={copy}
          feedbackOpen={feedbackOpen}
          onFeedbackOpen={setFeedbackOpen}
          onApprove={() => actions?.approvePlan(m.requestId)}
          onReject={(fb) => {
            actions?.rejectPlan(m.requestId, fb);
            setFeedbackOpen(false);
          }}
          onOpenRead={() => setReadOpen(true)}
          busy={!!actions?.busy}
        />
        {readOpen && (
          <PlanReadOverlay
            model={m}
            copy={copy}
            lang={lang}
            onClose={() => setReadOpen(false)}
            onApprove={() => {
              actions?.approvePlan(m.requestId);
              setReadOpen(false);
            }}
            onRequestChanges={() => {
              setReadOpen(false);
              setFeedbackOpen(true);
            }}
          />
        )}
      </>
    );
  }
  return <InteractionSummaryRow tone={v.tone} label={v.label} text={v.text} />;
}

function Row({ row, interactionActions, editCopy, onStartEdit, editDisabled, regen, streamKey }: {
  row: ChatRow;
  interactionActions?: InteractionActions;
  editCopy?: MEditCopy;
  onStartEdit?: () => void;
  editDisabled?: boolean;
  regen?: boolean;
  /** Identity of the live stream these rows belong to — see AssistantBlock. */
  streamKey?: string;
}): JSX.Element | null {
  switch (row.kind) {
    case 'divider':
      return <Divider text={row.text} />;
    case 'user':
      return <UserBubble text={row.text} attachments={row.attachments} ts={row.ts} edited={row.edited} editCopy={editCopy} onStartEdit={onStartEdit} editDisabled={editDisabled} pending={row.pending} debug={row.debug} />;
    case 'tools':
      return <ToolCallsRow calls={row.calls.map((c) => ({ label: c.kind, kind: c.kind, input: c.input, ...(c.debug ? { debug: c.debug } : {}) }))} />;
    case 'assistant':
      return <AssistantBlock text={row.text} attachments={row.attachments} editCopy={editCopy} regen={regen} preview={row.preview} streamKey={streamKey} />;
    case 'notice':
      return <ChatNotice level={row.level} text={row.text} />;
    case 'interaction':
      return <InteractionRowCard row={row} actions={interactionActions} />;
    default:
      return null;
  }
}

/** Presentational transcript column — the ordered chat rows (divider / user / tools / assistant) laid
 *  out vertically. Framework-free of the scroll/stick behavior so it can be embedded wherever a
 *  transcript needs rendering (the workbench center chat, the thread-detail step chat). Owns the
 *  sec-23 message-edit state when an `edit` context is passed (the workbench center chat): the edited
 *  bubble becomes an in-place EditBox, later rows dim under a「将被回退」badge, and submit fires
 *  the rewind. */
export function ChatRows({ rows, interactionActions, edit, streamKey }: { rows: ChatRow[]; interactionActions?: InteractionActions; edit?: MessageEditCtx; streamKey?: string }): JSX.Element {
  const lang = useLang();
  const editCopy = lang === 'zh' ? M_EDIT_COPY.zh : M_EDIT_COPY.en;
  // The row currently being edited (a user row with a turnIndex). Reset when the row set changes
  // shape enough that the anchor no longer matches (guard inside the render below).
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const regenIdx = regenNoteIndexes(rows);

  const editingRow = editingIdx != null ? rows[editingIdx] : null;
  const editingValid = !!edit && !!editingRow && editingRow.kind === 'user' && editingRow.turnIndex !== undefined;
  const stats = editingValid ? rewindStats(rows, editingIdx!) : null;

  const rowKey = (row: ChatRow, i: number): string | number =>
    row.kind === 'interaction' && row.detail ? `int-${row.detail.id}` : i;

  if (editingValid) {
    const er = editingRow as Extract<ChatRow, { kind: 'user' }>;
    const before = rows.slice(0, editingIdx!);
    const after = rows.slice(editingIdx! + 1);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {before.map((row, i) => (
          <Row key={rowKey(row, i)} row={row} interactionActions={interactionActions} streamKey={streamKey} />
        ))}
        <EditBox
          initialText={er.text}
          copy={editCopy}
          busy={edit!.busy}
          onCancel={() => setEditingIdx(null)}
          onSubmit={(text) => {
            edit!.onSubmit(er.turnIndex!, text);
            setEditingIdx(null);
          }}
        />
        {stats && <RewindNote replies={stats.replies} toolCalls={stats.toolCalls} copy={editCopy} />}
        {after.length > 0 && (
          <RewindTail copy={editCopy}>
            {after.map((row, i) => (
              <Row key={rowKey(row, editingIdx! + 1 + i)} row={row} interactionActions={interactionActions} streamKey={streamKey} />
            ))}
          </RewindTail>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {rows.map((row, i) => (
        <Row
          key={rowKey(row, i)}
          row={row}
          interactionActions={interactionActions}
          editCopy={editCopy}
          regen={regenIdx.has(i)}
          onStartEdit={edit && row.kind === 'user' && row.turnIndex !== undefined ? () => setEditingIdx(i) : undefined}
          editDisabled={edit?.running || edit?.busy}
          streamKey={streamKey}
        />
      ))}
    </div>
  );
}

export function MessageStream({ rows, loading, inlineThreadCard, interactionActions, edit, streamKey }: { rows: ChatRow[]; loading: boolean; inlineThreadCard?: React.ReactNode; interactionActions?: InteractionActions; edit?: MessageEditCtx; streamKey?: string }): JSX.Element {
  const populated = rows.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
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

  // …and keep it pinned while the content GROWS between row changes. The streamed reply is revealed
  // character by character, so the block gets taller many times per row change; without this the
  // line being written slides under the bottom edge (measured: up to one line) and snaps back only
  // when the next delta arrives, which reads as a twitch under otherwise smooth text. Observing the
  // content box catches every cause of growth (the reveal, a late-loading image, markdown reflow)
  // and writes scrollTop directly — no React state, so it costs no render.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      <div ref={contentRef} style={{ width: '100%', maxWidth: 756, margin: '0 auto', padding: '22px 32px 12px' }}>
        {!populated && !loading && <EmptyChat />}
        <ChatRows rows={rows} interactionActions={interactionActions} edit={edit} streamKey={streamKey} />
        {inlineThreadCard && <div style={{ marginTop: 16 }}>{inlineThreadCard}</div>}
      </div>
    </div>
  );
}
