// @ds-adherence-ignore -- mobile v3 chat surface, chrome extracted 1:1 from scheme-mobile.dc.html
// (1b L136-168 · 1o L753-786 · 1p L799-845 · 5a reject composer L200-218). Raw px/hex/font/svg by
// design §8.3 — the mobile palette is not in the light `proto.*` token set. Pure + presentational:
// every field is a prop, no tRPC. The container (MChatScreen) owns data + mutations + live sync.
// Interaction cards (6a plan / 5b ask / 4a-c sealed) live in MInteractionCards. The composer
// meta row places the context modal and manual compact action beside the profile selector.
//
// Live rows and semantic notices are drawn the same way as their desktop counterparts. Two rows
// carry live state rather than history, and both are drawn the way the desktop chat draws
// them. The block being written right now (`preview`) is revealed at a steady character rate instead
// of a delta at a time, through the SHARED pacing rule and frame loop (`features/workbench`
// reveal-pacing + useRevealedText) — see MAssistantBlock. A message written into a running turn that
// the model has not read yet (`pending`) is pinned below everything, the preview included, and says
// so with dimmed text alone: the same ink bubble, full opacity, no icon, badge or spinner.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionContextUsage } from '@cortex-agent/ui-contract';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import { ContextUsageControl, type ContextCompactAction } from '@/features/workbench/ContextUsageControl';
import { useRevealedText } from '@/features/workbench/useRevealedText';
import { ChatNotice } from '@/features/workbench/ChatNotice';
import { regenNoteIndexes, type ChatRow, type Attachment } from '@/features/workbench/transcript-vm';
import { buildSessionIdRows } from '@/features/workbench/session-id';
import {
  interactionView,
  emptyAskAnswers,
  type AskCardModel,
  type PlanCardModel,
  type AskAnswerState,
} from '@/features/workbench/interaction-vm';
import { toolChips } from '@/mobile/screens/mobile-session-vm';
import { MDrillHeader, MMoreButton, MComposer, MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import { downloadFile } from '@/lib/files';
import { useMediaViewer } from '@/features/media/MediaViewer';
import { useDocViewer } from '@/features/media/DocViewer';
import { useWorkspaceObjectUrl } from '@/features/media/useWorkspaceObjectUrl';
import { mediaKindOf } from '@/features/media/media-kind';
import { VideoThumb } from '@/features/media/VideoThumb';
import { docKindOf } from '@/features/media/doc-kind';
import { MAskCard, MPlanCard, M_INT_COPY, type MIntCopy } from './MInteractionCards';
import type { ChatHeaderStatus, ProfileSheetItem, PendingAttachmentVM } from './m-chat-vm';

export interface MChatCopy {
  composerPh: string;
  toolCallsUnit: string;
  menuRename: string;
  menuExport: string;
  menuArchive: string;
  menuSessionId: string;
  // Session ID sheet (⋯ → 会话ID)
  sessionIdTitle: string;
  cortexIdLabel: string;
  backendUuidLabel: string;
  copy: string;
  copied: string;
  attachCamera: string;
  attachLibrary: string;
  attachFile: string;

  attachPlaceholder: string;
  profileTitle: string;
  profileSubtitle: string;
  profileCurrent: string;
  profileFooter: string;
  // Full-screen editor (2b) footer counter units.
  lineUnit: string;
  charUnit: string;
}

/** Interaction handlers + per-card local state threaded from the screen into the stream cards.
 *  All optional — a stream without handlers renders the cards inert (e.g. static tests). */
export interface MChatInteractions {
  copy: MIntCopy;
  askState: (requestId: string) => AskAnswerState;
  onAskPick: (model: AskCardModel, label: string) => void;
  onAskToggle: (model: AskCardModel, label: string) => void;
  onAskConfirmMulti: (model: AskCardModel) => void;
  onAskCustom: (model: AskCardModel) => void;
  /** The plan card currently in 5a reject mode (dimmed) — null when none. */
  rejectingId: string | null;
  onApprove: (model: PlanCardModel) => void;
  onRejectStart: (model: PlanCardModel) => void;
  onOpenRead: (model: PlanCardModel) => void;
}

/** 5a reject composer chrome — amber context bar + reason chips above the composer. */
export interface MRejectBar {
  title: string;
  chips: string[];
  onChipTap: (chip: string) => void;
  onCancel: () => void;
}

// ── sec-7 message edit + rewind chrome ────────────────────────────────────────

export interface MChatEditCopy {
  menuCopy: string;
  menuEdit: string;
  /** 编辑中 badge on the bubble being edited (7b). */
  editingBadge: string;
  /** 将被回退 · N 条回复 · M 次工具调用 (7b). */
  willRewind: (replies: number, toolCalls: number) => string;
  /** 编辑消息 — 发送将回退后续回复 (7b context bar). */
  editBarTitle: string;
  /** 已编辑 under-bubble note; tap opens the original sheet. */
  edited: string;
  /** 原消息 sheet header. */
  original: string;
  /** 由编辑重新生成 footnote. */
  regenNote: string;
}

/** 7a long-press menu state: which row is held + what actions apply. */
export interface MMsgMenu {
  rowIndex: number;
  onCopy: () => void;
  /** The long-press menu is user-messages-only; onEdit is always present in practice. */
  onEdit?: () => void;
  /** True while running — the 编辑 row greys out (7a footnote). */
  editDisabled?: boolean;
  onClose: () => void;
}

/** 7b edit mode: the row being edited + the discard stats for the 将被回退 badge. */
export interface MEditMode {
  rowIndex: number;
  replies: number;
  toolCalls: number;
  onCancel: () => void;
}

/** Long-press (~450ms) handlers for a stream bubble; also fires on contextmenu (desktop testing). */
function longPressHandlers(fire: () => void): {
  onTouchStart: () => void;
  onTouchEnd: () => void;
  onTouchMove: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    onTouchStart: () => { timer = setTimeout(fire, 450); },
    onTouchEnd: () => { if (timer) clearTimeout(timer); },
    onTouchMove: () => { if (timer) clearTimeout(timer); },
    onContextMenu: (e) => { e.preventDefault(); fire(); },
  };
}

/** 7a — the long-press action overlay: conversation dims + blurs, the held bubble floats, the
 *  复制 / 编辑消息 menu hangs under it (user messages only; running: edit greyed). */
export function MsgActionMenu({ row, menu, copy }: { row: ChatRow; menu: MMsgMenu; copy: MChatEditCopy }): JSX.Element {
  const isUser = row.kind === 'user';
  const text = row.kind === 'user' || row.kind === 'assistant' ? row.text : '';
  const item = (label: string, onTap: (() => void) | undefined, disabled?: boolean, last?: boolean): JSX.Element => (
    <div
      role="button"
      onClick={disabled ? undefined : () => { onTap?.(); menu.onClose(); }}
      style={{
        display: 'flex', alignItems: 'center', height: 46, padding: '0 15px', fontSize: 14.5,
        color: MC.ink, opacity: disabled ? 0.35 : 1, cursor: disabled ? 'default' : 'pointer',
        borderTop: last ? '1px solid rgba(0,0,0,.07)' : undefined,
      }}
    >
      {label}
      {label === copy.menuCopy ? (
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke={MC.muted} strokeWidth="1.4" style={{ marginLeft: 'auto' }}>
          <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" /><path d="M2.5 9.5V3.5a1 1 0 0 1 1-1h6" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke={MC.muted} strokeWidth="1.4" style={{ marginLeft: 'auto' }}>
          <path d="M2.5 11.5l.6-2.6 6.4-6.4a1.3 1.3 0 0 1 1.8 0l.2.2a1.3 1.3 0 0 1 0 1.8L5.1 10.9z" /><path d="M8.6 3.4l2 2" />
        </svg>
      )}
    </div>
  );
  return (
    <div
      onClick={menu.onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 8, background: 'rgba(25,28,34,.38)',
        backdropFilter: 'blur(1.5px)', WebkitBackdropFilter: 'blur(1.5px)',
        padding: '120px 14px 0', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 9,
      }}
    >
      {/* Floated copy of the held bubble */}
      {isUser ? (
        <div style={{ maxWidth: '82%', background: MC.ink, color: 'var(--ink-solid-fg)', borderRadius: '16px 16px 4px 16px', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.55, boxShadow: '0 14px 40px rgba(0,0,0,.4)', maxHeight: '38%', overflow: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
          {text}
        </div>
      ) : (
        <div style={{ maxWidth: '88%', background: 'var(--proto-card)', color: MC.body, borderRadius: 14, padding: '9px 13px', fontSize: 13.5, lineHeight: 1.6, boxShadow: '0 14px 40px rgba(0,0,0,.4)', maxHeight: '38%', overflow: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
          {text}
        </div>
      )}
      {/* Menu — 复制 / 编辑消息 (46px rows, scheme 7a) */}
      <div onClick={(e) => e.stopPropagation()} style={{ width: 196, background: 'rgba(250,250,252,.98)', border: '1px solid rgba(0,0,0,.06)', borderRadius: 13, boxShadow: '0 14px 40px rgba(16,24,40,.25)', overflow: 'hidden' }}>
        {item(copy.menuCopy, menu.onCopy)}
        {menu.onEdit && item(copy.menuEdit, menu.onEdit, menu.editDisabled, true)}
      </div>
    </div>
  );
}

/** 7b — the accent context bar above the composer while editing (mirror of the 5a amber bar). */
export function EditBar({ title, onCancel }: { title: string; onCancel: () => void }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--proto-alt)', border: '1px solid var(--proto-accent-border)', borderRadius: 11, padding: '8px 8px 8px 12px', marginBottom: 7 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.run, flex: 'none' }} />
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-accent-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
      <div
        role="button"
        aria-label="Cancel edit"
        onClick={onCancel}
        style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: 8, background: 'var(--proto-card)', border: '1px solid var(--proto-accent-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: MC.run, fontSize: 12, flex: 'none', cursor: 'pointer' }}
      >
        ×
      </div>
    </div>
  );
}

// ── 1b header — ‹ back · title + status line · ⋯ menu ─────────────────────────
interface MChatHeaderProps {
  title: string;
  status: ChatHeaderStatus;
  onBack: () => void;
  onMore: () => void;
}

export function MChatHeader(props: MChatHeaderProps): JSX.Element {
  return (
    <MDrillHeader onBack={props.onBack} trailing={<MMoreButton onClick={props.onMore} />}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {props.title}
        </div>
        <MChatStatusLine {...props} />
      </div>
    </MDrillHeader>
  );
}

function MChatStatusLine({ status }: MChatHeaderProps): JSX.Element {
  return (
    <div data-chat-status-line="true" style={{ display: 'flex', alignItems: 'center', gap: 8, font: `400 10px ${MONO}`, color: status.tone === 'waiting' ? MC.amberText : MC.muted, marginTop: 1 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: status.tone === 'waiting' ? MC.amber : status.running ? MC.run : 'var(--proto-line-3)', animation: status.running ? 'cxpulse 1.6s ease-in-out infinite' : undefined, flex: 'none' }} />
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status.text}</span>
      </span>
    </div>
  );
}

// The ⋯ menu: 会话ID (real → opens the Session ID sheet) + 重命名/导出/归档 (no backend op; honest
// affordance, inert).
export function MoreMenu({ copy, onClose, onSessionId }: { copy: MChatCopy; onClose: () => void; onSessionId: () => void }): JSX.Element {
  const items: { label: string; onTap: () => void }[] = [
    { label: copy.menuSessionId, onTap: onSessionId },
    { label: copy.menuRename, onTap: onClose },
    { label: copy.menuExport, onTap: onClose },
    { label: copy.menuArchive, onTap: onClose },
  ];
  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 5 }} />
      <div
        style={{
          position: 'absolute',
          top: 'calc(52px + env(safe-area-inset-top))',
          right: 14,
          width: 148,
          background: 'rgba(250,250,252,.98)',
          border: '1px solid rgba(0,0,0,.06)',
          borderRadius: 13,
          boxShadow: '0 14px 40px rgba(16,24,40,.2)',
          overflow: 'hidden',
          zIndex: 6,
        }}
      >
        {items.map((it, i) => (
          <div
            key={it.label}
            onClick={it.onTap}
            style={{
              padding: '11px 14px',
              fontSize: 13,
              color: MC.ink,
              borderBottom: i < items.length - 1 ? '1px solid var(--proto-line-2)' : undefined,
              cursor: 'pointer',
            }}
          >
            {it.label}
          </div>
        ))}
      </div>
    </>
  );
}

// Session ID sheet (⋯ → 会话ID) — a bottom sheet showing the two identifiers a session carries: the
// human-facing Cortex ID (cortex-XXXX) and the backend UUID. Each row is copy-to-clipboard.
export function SessionIdSheet({
  copy,
  cortexId,
  backendUuid,
  onClose,
}: {
  copy: MChatCopy;
  cortexId: string | null | undefined;
  backendUuid: string | null | undefined;
  onClose: () => void;
}): JSX.Element {
  const rows = buildSessionIdRows({
    cortexId,
    backendUuid,
    cortexIdLabel: copy.cortexIdLabel,
    backendUuidLabel: copy.backendUuidLabel,
  });
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const doCopy = (key: string, value: string): void => {
    if (value === '—') return;
    void navigator.clipboard?.writeText(value).catch(() => {});
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1400);
  };
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em', padding: '0 2px 12px' }}>
        {copy.sessionIdTitle}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {rows.map((row) => (
          <div key={row.key}>
            <div style={{ font: `600 9.5px ${MONO}`, letterSpacing: '.05em', color: MC.muted, padding: '0 2px 5px' }}>
              {row.label}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'var(--proto-card)',
                border: `1px solid ${MC.hairline}`,
                borderRadius: 11,
                padding: '10px 12px',
              }}
            >
              <span style={{ flex: 1, font: `500 12px ${MONO}`, color: MC.ink, wordBreak: 'break-all', userSelect: 'all' }}>
                {row.value}
              </span>
              <span
                role="button"
                onClick={() => doCopy(row.key, row.value)}
                style={{
                  flex: 'none',
                  font: `600 9.5px ${MONO}`,
                  color: copiedKey === row.key ? MC.run : MC.muted,
                  border: `1px solid ${copiedKey === row.key ? MC.runBorder : 'var(--proto-line-3)'}`,
                  borderRadius: 7,
                  padding: '4px 9px',
                  cursor: row.value === '—' ? 'default' : 'pointer',
                  opacity: row.value === '—' ? 0.4 : 1,
                }}
              >
                {copiedKey === row.key ? copy.copied : copy.copy}
              </span>
            </div>
          </div>
        ))}
      </div>
    </MBottomSheet>
  );
}

// ── attachment tiles (scheme 1o L762-766) ─────────────────────────────────────
const STRIPES = 'repeating-linear-gradient(45deg,var(--proto-line) 0 6px,var(--proto-rail) 6px 12px)';

function AttachmentTile({ a }: { a: Attachment }): JSX.Element {
  const kind = mediaKindOf(a.type);
  const { openMedia } = useMediaViewer();
  const { openDoc } = useDocViewer();
  const docKind = docKindOf(a.name, a.mimeType);
  // Real thumbnail (auth-fetched) for image/video; tap opens the media lightbox (no new tab).
  const url = useWorkspaceObjectUrl(a.path, kind !== null);
  if (kind !== null) {
    return (
      <div
        role="button"
        onClick={() => openMedia({ kind, name: a.name, path: a.path })}
        style={{
          width: a.type === 'video' ? 104 : 74,
          height: 74,
          borderRadius: 12,
          background: url ? '#000' : STRIPES,
          position: 'relative',
          overflow: 'hidden',
          flex: 'none',
          cursor: 'pointer',
        }}
      >
        {url && kind === 'image' && (
          <img src={url} alt={a.name} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
        {url && kind === 'video' && (
          <VideoThumb src={url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
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
              background: 'rgba(25,28,34,.72)',
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
            left: 7,
            bottom: 6,
            maxWidth: (a.type === 'video' ? 104 : 74) - 14,
            font: `500 8px ${MONO}`,
            color: MC.muted,
            background: 'rgba(255,255,255,.85)',
            padding: '1px 5px',
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
  // PDF/text tap → in-app DocViewer; other files tap → native download (save to disk).
  const onTap = docKind
    ? () => openDoc({ kind: docKind, name: a.name, path: a.path, mimeType: a.mimeType })
    : () => void downloadFile(a.path, a.name);
  return (
    <div
      role="button"
      onClick={onTap}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--proto-card)',
        border: `1px solid ${MC.hairline}`,
        borderRadius: 9,
        padding: '6px 10px',
        flex: 'none',
        cursor: 'pointer',
      }}
    >
      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={MC.muted} strokeWidth="1.5">
        <path d="M3 1.5h5.5L11.5 4v8.5h-8.5z" />
        <path d="M8.5 1.5V4H11" />
      </svg>
      <span style={{ font: `500 10.5px ${MONO}`, color: MC.body }}>{a.name}</span>
    </div>
  );
}

// `side` follows the message it belongs to: user attachments hug the right (with the dark user
// bubble), agent attachments hug the left (with the agent message body).
function AttachmentGroup({ attachments, side = 'right' }: { attachments: Attachment[]; side?: 'left' | 'right' }): JSX.Element {
  const edge = side === 'left' ? 'flex-start' : 'flex-end';
  return (
    <div style={{ alignSelf: edge, display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: edge }}>
      {attachments.map((a, i) => (
        <AttachmentTile key={i} a={a} />
      ))}
    </div>
  );
}

// ── collapsed/expandable tool-call row (scheme 1b L146; tap to expand) ─────────
function ToolCallsRow({
  count,
  calls,
  unit,
}: {
  count: number;
  calls: { kind: string; input: string }[];
  unit: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const chips = toolChips(calls);
  if (!expanded) {
    return (
      <div
        onClick={() => setExpanded(true)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--proto-muted-3)', flexWrap: 'wrap', cursor: 'pointer' }}
      >
        <span style={{ fontSize: 8.5 }}>▸</span>
        <span>
          {count} {unit}
        </span>
        {chips.names.map((name, i) => (
          <span key={i} style={{ font: `400 10px ${MONO}`, background: 'var(--proto-card)', border: '1px solid var(--proto-line-2)', padding: '1px 6px', borderRadius: 4 }}>
            {name}
          </span>
        ))}
        {chips.overflow > 0 && <span>+{chips.overflow}</span>}
      </div>
    );
  }
  return (
    <div style={{ background: 'var(--proto-rail)', border: '1px solid var(--proto-line-2)', borderRadius: 8, overflow: 'hidden' }}>
      <div onClick={() => setExpanded(false)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--proto-muted-3)', padding: '6px 11px', cursor: 'pointer' }}>
        <span style={{ fontSize: 8.5 }}>▾</span>
        <span>
          {count} {unit}
        </span>
      </div>
      {calls.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5.5px 11px', borderTop: '1px solid var(--proto-line-soft)' }}>
          <span style={{ font: `600 9px ${MONO}`, color: 'var(--proto-muted)', background: 'var(--proto-gray)', padding: '1.5px 7px', borderRadius: 5, flex: 'none' }}>{c.kind}</span>
          <span style={{ font: `400 10.5px ${MONO}`, color: MC.body, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{c.input}</span>
        </div>
      ))}
    </div>
  );
}

// ── the message stream (reuses ChatMarkdown; renders attachments above/below bubbles) ──

const NOOP = (): void => {};

/**
 * One assistant block. `preview` marks the block being written RIGHT NOW (the token-level
 * accumulation) — the only row the smooth reveal paces, using the same rule and the same frame loop
 * as the desktop chat (`features/workbench/reveal-pacing` + `useRevealedText`). `streaming` cannot
 * express this: the idle heuristic also flags the last COMPLETE row for a couple of seconds after
 * the turn's final event, and pacing a settled message would re-type text already read.
 *
 * Paced and committed text render through this SAME component instance (the preview row and the
 * message that supersedes it occupy the same position in the stream), so when the authoritative text
 * lands the row simply stops being a preview and is drawn whole on that render — it settles without
 * a remount. No caret either way: the blinking output-position block was removed by request.
 *
 * `dropTrailingHr` — assistant messages often end with a `---` separator; on mobile that dangling
 * horizontal rule reads as cruft, so it is stripped.
 */
function MAssistantBlock({ text, preview, streamKey }: {
  text: string;
  preview?: boolean;
  streamKey?: string;
}): JSX.Element | null {
  const shown = useRevealedText(text, !!preview, streamKey);
  if (!shown.trim()) return null;
  return <ChatMarkdown text={shown} dropTrailingHr />;
}

/** Interaction row for the mobile stream (scheme 6a/5b/4a-c). Entity rows render the full cards
 *  — pending actionable, resolved sealed in place; expired/cancelled + legacy rows render a
 *  one-line summary. Without handlers the cards render inert. */
function MInteractionRow({ row, interactions }: { row: Extract<ChatRow, { kind: 'interaction' }>; interactions?: MChatInteractions }): JSX.Element {
  const v = interactionView(row);
  const copy = interactions?.copy ?? M_INT_COPY.zh;
  if (v.kind === 'ask') {
    const m = v.model;
    return (
      <MAskCard
        model={m}
        state={interactions?.askState(m.requestId) ?? emptyAskAnswers}
        copy={copy}
        onPick={(label) => interactions?.onAskPick(m, label)}
        onToggle={(label) => interactions?.onAskToggle(m, label)}
        onConfirmMulti={() => interactions?.onAskConfirmMulti(m)}
        onCustom={() => interactions?.onAskCustom(m)}
      />
    );
  }
  if (v.kind === 'plan') {
    const m = v.model;
    return (
      <MPlanCard
        model={m}
        copy={copy}
        dimmed={interactions?.rejectingId === m.requestId}
        onApprove={interactions ? () => interactions.onApprove(m) : NOOP}
        onRejectStart={interactions ? () => interactions.onRejectStart(m) : NOOP}
        onOpenRead={interactions ? () => interactions.onOpenRead(m) : NOOP}
      />
    );
  }
  const color = v.tone === 'rejected' ? 'var(--proto-danger)' : v.tone === 'inactive' ? 'var(--proto-muted-3)' : MC.done;
  const icon = v.tone === 'rejected' ? '✗' : v.tone === 'inactive' ? '◌' : '✓';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', background: 'var(--proto-card)', border: '1px solid var(--proto-line-2)', borderRadius: 10, opacity: v.tone === 'inactive' ? 0.6 : 0.75 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color, flexShrink: 0 }}>{icon} {v.label}</span>
      <span style={{ fontSize: 11.5, color: MC.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.text}</span>
    </div>
  );
}

export function MChatStream({ rows, toolCallsUnit, interactions, editCopy, editing, onLongPress, onShowOriginal, streamKey }: {
  rows: ChatRow[];
  toolCallsUnit: string;
  interactions?: MChatInteractions;
  /** Identity of the live stream these rows belong to (the session) — a change settles the reveal
   *  instead of pacing the next chat's reply onward from this one's progress. */
  streamKey?: string;
  /** Present → the sec-7 edit affordances render (long-press menu, 编辑中/将被回退, 已编辑 note). */
  editCopy?: MChatEditCopy;
  /** 7b edit mode: the held row rings 编辑中, later rows dim under the 将被回退 badge. */
  editing?: MEditMode | null;
  /** Long-press on a user/assistant bubble (opens the 7a action menu). */
  onLongPress?: (rowIndex: number) => void;
  /** Tap on the 已编辑 note (opens the original-message sheet). */
  onShowOriginal?: (edited: { originalText: string; originalTs: string }) => void;
}): JSX.Element {
  const regenIdx = editCopy ? regenNoteIndexes(rows) : null;
  const editingIdx = editing?.rowIndex ?? null;
  return (
    <>
      {rows.map((row, i) => {
        const dimmed = editingIdx != null && i > editingIdx;
        const isEditingRow = editingIdx === i;
        // Long-press affordance (复制 / 编辑消息) is user-messages-only — agent messages carry no copy.
        const canHold = !!editCopy && !!onLongPress && editingIdx == null && row.kind === 'user';
        const hold = canHold ? longPressHandlers(() => onLongPress!(i)) : null;
        return (
        <Fragment key={row.kind === 'interaction' && row.detail ? `int-${row.detail.id}` : i}>
          {row.kind === 'divider' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, ...(dimmed ? { opacity: 0.35 } : {}) }}>
              <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
              <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.06em', color: MC.faint }}>{row.text}</div>
              <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
            </div>
          )}
          {row.kind === 'user' && (
            <>
              {row.attachments && row.attachments.length > 0 && <AttachmentGroup attachments={row.attachments} />}
              <div style={{ alignSelf: 'flex-end', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, maxWidth: '82%', ...(dimmed ? { opacity: 0.35, pointerEvents: 'none' as const } : {}) }}>
                {/* 7b — the bubble being edited rings accent + 编辑中 badge */}
                {isEditingRow && editCopy && (
                  <span style={{ font: `600 9.5px ${MONO}`, color: MC.run, background: 'var(--proto-accent-bg)', padding: '2px 7px', borderRadius: 4 }}>{editCopy.editingBadge}</span>
                )}
                <div
                  {...(hold ?? {})}
                  style={{
                    background: MC.ink,
                    // A message written into the running turn's backend that the model has not read
                    // yet dims its TEXT and nothing else — same bubble, full opacity, no icon, badge
                    // or spinner. The row is provisional, not disabled or failing, and any marker
                    // heavier than the ink would read as one. It clears the instant it is delivered.
                    color: row.pending ? MC.inkSolidFgDim : MC.inkSolidFg,
                    borderRadius: '16px 16px 4px 16px',
                    padding: '9px 13px',
                    fontSize: 13.5,
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'break-word',
                    wordBreak: 'break-word',
                    WebkitUserSelect: canHold ? 'none' : undefined,
                    userSelect: canHold ? 'none' : undefined,
                    WebkitTouchCallout: canHold ? 'none' : undefined,
                    ...(isEditingRow ? { boxShadow: `0 0 0 2px ${MC.canvas}, 0 0 0 3.5px ${MC.run}` } : {}),
                  } as React.CSSProperties}
                >
                  {row.text}
                </div>
                {/* 已编辑 note — tap opens the original-message sheet */}
                {editCopy && row.edited && !isEditingRow && (
                  <span
                    role="button"
                    onClick={onShowOriginal ? () => onShowOriginal(row.edited!) : undefined}
                    style={{ font: `400 9.5px ${MONO}`, color: MC.faint, cursor: 'pointer' }}
                  >
                    <span style={{ borderBottom: `1px dotted ${MC.faint}` }}>{editCopy.edited}</span>
                  </span>
                )}
              </div>
              {/* 7b — the 将被回退 badge opens the dimmed tail right after the edited bubble */}
              {isEditingRow && editCopy && editing && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <span style={{ font: `600 9px ${MONO}`, color: 'var(--m-amber-ink)', background: MC.amberBg, padding: '2px 7px', borderRadius: 4 }}>
                    {editCopy.willRewind(editing.replies, editing.toolCalls)}
                  </span>
                </div>
              )}
            </>
          )}
          {row.kind === 'tools' && (
            <div style={dimmed ? { opacity: 0.35, pointerEvents: 'none' } : undefined}>
              <ToolCallsRow count={row.count} calls={row.calls} unit={toolCallsUnit} />
            </div>
          )}
          {row.kind === 'notice' && (
            <div style={dimmed ? { opacity: 0.35, pointerEvents: 'none' } : undefined}>
              <ChatNotice level={row.level} text={row.text} />
            </div>
          )}
          {row.kind === 'assistant' && (
            <div
              {...(hold ?? {})}
              style={{ fontSize: 13.5, lineHeight: 1.65, color: MC.body, minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word', ...(dimmed ? { opacity: 0.35, pointerEvents: 'none' as const } : {}), WebkitUserSelect: canHold ? 'none' : undefined, userSelect: canHold ? 'none' : undefined, WebkitTouchCallout: canHold ? 'none' : undefined } as React.CSSProperties}
            >
              {/* 由编辑重新生成 — footnote atop the first regenerated reply after an edit */}
              {editCopy && regenIdx?.has(i) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, font: `400 9.5px ${MONO}`, color: MC.faint, marginBottom: 4 }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--proto-line-3)', flex: 'none' }} />
                  {editCopy.regenNote}
                </div>
              )}
              <MAssistantBlock text={row.text} preview={row.preview} streamKey={streamKey} />
              {row.attachments && row.attachments.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <AttachmentGroup attachments={row.attachments} side="left" />
                </div>
              )}
            </div>
          )}
          {row.kind === 'interaction' && (
            <div style={dimmed ? { opacity: 0.35, pointerEvents: 'none' } : undefined}>
              <MInteractionRow row={row} interactions={interactions} />
            </div>
          )}
        </Fragment>
        );
      })}
    </>
  );
}

// Client-annotated system line in the stream (scheme 1p L808) — e.g. a real profile switch.
export function SystemLine({ text }: { text: string }): JSX.Element {
  return (
    <div
      style={{
        alignSelf: 'center',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        font: `400 9.5px ${MONO}`,
        color: MC.faint,
        background: 'var(--proto-card)',
        border: '1px solid var(--proto-line-2)',
        padding: '3px 10px',
        borderRadius: 999,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: MC.run }} />
      {text}
    </div>
  );
}

// ── 1o ＋ attach menu (scheme L783-787) ───────────────────────────────────────
export function AttachMenu({ copy, onClose, onCamera, onLibrary, onFile }: { copy: MChatCopy; onClose: () => void; onCamera: () => void; onLibrary: () => void; onFile: () => void }): JSX.Element {
  const row = (label: string, on: () => void, icon: ReactNode, last?: boolean): JSX.Element => (
    <div
      onClick={() => { on(); onClose(); }}
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', borderBottom: last ? undefined : '1px solid var(--proto-line-2)', cursor: 'pointer' }}
    >
      {icon}
      <span style={{ fontSize: 13, color: MC.ink }}>{label}</span>
    </div>
  );
  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 5 }} />
      <div
        style={{
          position: 'absolute',
          left: 14,
          bottom: 90,
          width: 196,
          background: 'rgba(250,250,252,.98)',
          border: '1px solid rgba(0,0,0,.06)',
          borderRadius: 13,
          boxShadow: '0 14px 40px rgba(16,24,40,.2)',
          overflow: 'hidden',
          zIndex: 6,
        }}
      >
        {row(
          copy.attachCamera,
          onCamera,
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={MC.ink} strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="2" /><circle cx="8" cy="8.7" r="2.6" /><path d="M5.5 4l1-1.7h3l1 1.7" /></svg>,
        )}
        {row(
          copy.attachLibrary,
          onLibrary,
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={MC.ink} strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="2.5" /><circle cx="6" cy="6" r="1.3" /><path d="M2.5 11.5 6 8.5l2.5 2 3-3 2 2" /></svg>,
        )}
        {row(
          copy.attachFile,
          onFile,
          <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke={MC.ink} strokeWidth="1.4"><path d="M3 1.5h5.5L11.5 4v8.5h-8.5z" /><path d="M8.5 1.5V4H11" /></svg>,
          true,
        )}
      </div>
    </>
  );
}

// Composer attachment chip (scheme 1o L773-774) — filename + upload progress / done ✓. Image/video
// chips show a real thumbnail and open the media lightbox on tap (no new tab).
function ComposerChip({ a, onRemove }: { a: PendingAttachmentVM; onRemove: () => void }): JSX.Element {
  const uploading = a.status === 'uploading';
  const { openMedia } = useMediaViewer();
  const kind = a.type ? mediaKindOf(a.type) : null;
  const canPreview = !!a.previewUrl && kind !== null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: uploading ? 7 : 6, background: 'var(--proto-card)', border: `1px solid ${uploading ? MC.runBorder : MC.hairline}`, borderRadius: 9, padding: '5px 9px', flex: 'none' }}>
      {canPreview && (
        <span
          role="button"
          onClick={() => openMedia({ kind: kind!, name: a.name, url: a.previewUrl! })}
          style={{ position: 'relative', width: 26, height: 26, borderRadius: 6, overflow: 'hidden', background: '#000', flex: 'none', cursor: 'pointer' }}
        >
          {kind === 'image' ? (
            <img src={a.previewUrl} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          ) : (
            <VideoThumb src={a.previewUrl!} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          )}
          {kind === 'video' && (
            <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-solid-fg)', fontSize: 8, textShadow: '0 0 3px rgba(0,0,0,.8)' }}>▶</span>
          )}
        </span>
      )}
      <span style={{ font: `500 10px ${MONO}`, color: MC.body }}>{a.name}</span>
      {uploading ? (
        <>
          <div style={{ width: 34, height: 4, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden' }}>
            <div style={{ width: `${a.progress}%`, height: '100%', background: MC.run }} />
          </div>
          <span style={{ font: `400 9px ${MONO}`, color: MC.run }}>{a.progress}%</span>
        </>
      ) : a.status === 'done' ? (
        <span style={{ fontSize: 10, color: MC.done, fontWeight: 700 }}>✓</span>
      ) : a.status === 'error' ? (
        <span style={{ fontSize: 10, color: MC.fail, fontWeight: 700 }}>!</span>
      ) : null}
      <span onClick={onRemove} style={{ color: MC.faint, fontSize: 11, cursor: 'pointer' }}>✕</span>
    </div>
  );
}

// ── 1p Profile bottom sheet (scheme L821-845) ─────────────────────────────────
export function ProfileSheet({ items, copy, onClose, onPick }: { items: ProfileSheetItem[]; copy: MChatCopy; onClose: () => void; onPick: (name: string) => void }): JSX.Element {
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 10px' }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>{copy.profileTitle}</span>
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint }}>{copy.profileSubtitle}</span>
      </div>
      <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 13, overflow: 'hidden' }}>
        {items.map((it, i) => (
          <div
            key={it.name}
            onClick={() => onPick(it.name)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: i < items.length - 1 ? '1px solid var(--proto-line-soft)' : undefined, cursor: 'pointer' }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ font: `600 13px ${MONO}`, color: MC.ink }}>{it.name}</span>
                {it.current && <span style={{ fontSize: 9.5, fontWeight: 600, padding: '1.5px 7px', borderRadius: 999, background: MC.runBg, color: MC.run }}>{copy.profileCurrent}</span>}
              </div>
              <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 3 }}>{it.sub}</div>
            </div>
            {it.current && <span style={{ fontSize: 15, fontWeight: 700, color: MC.run, flex: 'none' }}>✓</span>}
          </div>
        ))}
      </div>
      <div style={{ font: `400 9.5px ${MONO}`, color: MC.faint, padding: '9px 4px 0' }}>{copy.profileFooter}</div>
    </MBottomSheet>
  );
}

// ── the ＋ leading button + profile chip (composer chrome) ────────────────────
function PlusButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Attach"
      onClick={onClick}
      style={{ flex: 'none', width: 46, height: 46, borderRadius: 14, border: `1.5px solid ${MC.run}`, background: 'var(--proto-card)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', color: MC.run, fontSize: 22, fontWeight: 300, cursor: 'pointer' }}
    >
      ＋
    </button>
  );
}

function ProfileChip({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--proto-accent-bg)', background: 'var(--proto-card)', borderRadius: 999, padding: '4px 10px', flex: 'none', cursor: 'pointer' }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: MC.run }} />
      <span style={{ font: `600 10px ${MONO}`, color: MC.run }}>{label}</span>
      <span style={{ fontSize: 7.5, color: MC.muted }}>▾</span>
    </button>
  );
}

// ── the whole 1b screen composition ───────────────────────────────────────────
export interface MChatViewProps {
  title: string;
  status: ChatHeaderStatus;
  rows: ChatRow[];
  copy: MChatCopy;
  onBack: () => void;
  // header ⋯ menu
  moreOpen: boolean;
  onMoreToggle: () => void;
  onMoreClose: () => void;
  // ⋯ → 会话ID sheet
  sessionIdOpen: boolean;
  onSessionIdOpen: () => void;
  onSessionIdClose: () => void;
  cortexId: string | null;
  backendUuid: string | null;
  // stream slots
  inlineThreadCard?: ReactNode;
  systemLines?: string[];
  // Interaction cards live inline in `rows` (transcript entities); this supplies the per-card
  // handlers + session-local answer state (scheme 6a/5b/4a-c).
  interactions?: MChatInteractions;
  // 5a reject mode — amber context bar + reason chips above the composer; composer ring amber.
  rejectBar?: MRejectBar;
  // sec-7 message edit + rewind
  editCopy?: MChatEditCopy;
  /** 7a long-press action menu (held row + actions). */
  msgMenu?: MMsgMenu | null;
  onLongPress?: (rowIndex: number) => void;
  /** 7b edit mode — marks the stream + swaps the composer chrome to the accent edit bar. */
  editing?: MEditMode | null;
  /** 已编辑 tap → original-message sheet. */
  onShowOriginal?: (edited: { originalText: string; originalTs: string }) => void;
  originalSheet?: { text: string; onClose: () => void } | null;
  /** Identity of the live stream the rows belong to (the session) — see MChatStream. */
  streamKey?: string;
  // composer
  composerValue: string;
  onComposerChange: (v: string) => void;
  onSend: () => void;
  sendEnabled: boolean;
  /** Overrides the composer placeholder (5a 说明原因 / 5b 直接输入回答 Q{k}). */
  composerPlaceholder?: string;
  // Stop: while the session is running the composer shows a Stop button instead of Send.
  onStop?: () => void;
  stopEnabled?: boolean;
  profileChipLabel: string;
  onOpenProfile: () => void;
  contextUsage?: SessionContextUsage | null;
  contextUsageSupported?: boolean;
  contextUsageLang?: 'en' | 'zh';
  contextCompactAction?: ContextCompactAction;
  attachments: PendingAttachmentVM[];
  onRemoveAttachment: (id: string) => void;
  onPlus: () => void;
  attachMenuOpen: boolean;
  onAttachClose: () => void;
  onCamera: () => void;
  onLibrary: () => void;
  onFile: () => void;
  profileSheet?: { items: ProfileSheetItem[]; onClose: () => void; onPick: (name: string) => void };
}

export function MChatView(props: MChatViewProps): JSX.Element {
  const { copy } = props;

  // Open the session at the latest message (bottom), and keep it pinned to the bottom as new content
  // streams in — releasing when the user scrolls up, re-pinning once they scroll back down. Mirrors the
  // desktop MessageStream stick-to-bottom behavior.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Suppress auto-scroll briefly after user taps inside the stream (e.g. expanding a tool row),
  // so expanded content doesn't scroll out of view on the next streaming tick.
  const tapFreezeUntil = useRef(0);
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const onContentClick = (): void => {
    tapFreezeUntil.current = Date.now() + 800;
  };
  // After every content change (entry, streaming delta, profile system-line) keep the view pinned to
  // the bottom IF the user hasn't scrolled up — identical to the desktop MessageStream effect.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current && Date.now() >= tapFreezeUntil.current) el.scrollTop = el.scrollHeight;
  }, [props.rows, props.systemLines]);

  // …and keep it pinned while the content GROWS between row changes. Token-level streaming reveals
  // the reply character by character, so the block gets taller many times per row change; without
  // this the line being written slides under the bottom edge and snaps back only when the next delta
  // lands, which reads as a twitch under otherwise smooth text. Observing the content box catches
  // every cause of growth (the reveal, a late-loading image, markdown reflow) and writes scrollTop
  // directly — no React state, so it costs no render. Mirrors the desktop MessageStream observer,
  // and respects the same tap freeze as the row effect above.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current && Date.now() >= tapFreezeUntil.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // 7b edit mode replaces the composer chrome with the accent edit bar; 5a reject mode replaces it
  // with the amber feedback bar (+ ✕ cancel) + reason chips. Default mode keeps profile + context.
  const composerMode = props.editing && props.editCopy ? (
    <EditBar title={props.editCopy.editBarTitle} onCancel={props.editing.onCancel} />
  ) : props.rejectBar ? (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: MC.amberCard, border: `1px solid ${MC.amberBorder}`, borderRadius: 11, padding: '8px 8px 8px 12px', marginBottom: 7 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.amber, flex: 'none' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-amber-fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{props.rejectBar.title}</span>
        <div
          role="button"
          aria-label="Cancel reject"
          onClick={props.rejectBar.onCancel}
          style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: 8, background: 'var(--proto-card)', border: `1px solid ${MC.amberBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MC.amberText, fontSize: 11, flex: 'none', cursor: 'pointer' }}
        >
          ✕
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '0 2px 8px', overflowX: 'auto' }}>
        {props.rejectBar.chips.map((chip) => (
          <span
            key={chip}
            role="button"
            onClick={() => props.rejectBar!.onChipTap(chip)}
            style={{ flex: 'none', fontSize: 11, fontWeight: 600, color: MC.sub, border: '1px solid var(--proto-line-3)', background: 'var(--proto-card)', borderRadius: 999, padding: '5px 11px', cursor: 'pointer' }}
          >
            {chip}
          </span>
        ))}
      </div>
    </>
  ) : (
    <>
      {props.attachments.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '0 2px 7px', overflowX: 'auto' }}>
          {props.attachments.map((a) => (
            <ComposerChip key={a.id} a={a} onRemove={() => props.onRemoveAttachment(a.id)} />
          ))}
        </div>
      )}
      {/* Composer meta row: profile on the left, compact context usage right-aligned. */}
      <div data-mobile-composer-meta-row="true" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 7px' }}>
        <ProfileChip label={props.profileChipLabel} onClick={props.onOpenProfile} />
        {(props.contextUsageSupported || props.contextUsage != null) ? (
          <span data-context-usage-position="composer-profile" style={{ marginLeft: 'auto', display: 'inline-flex', flex: 'none' }}>
            <ContextUsageControl
              usage={props.contextUsage ?? null}
              supported={!!props.contextUsageSupported}
              variant="mobile"
              lang={props.contextUsageLang ?? 'en'}
              compactAction={props.contextCompactAction}
            />
          </span>
        ) : null}
      </div>
    </>
  );
  const above = composerMode;

  return (
    <div
      data-screen-label="1b 会话详情"
      style={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', background: MC.canvas }}
    >
      <MChatHeader
        title={props.title}
        status={props.status}
        onBack={props.onBack}
        onMore={props.onMoreToggle}
      />
      {/* Body region — a position:relative frame holding the scroll transcript + composer. The
          full-screen editor (2b) mounts as an absolute overlay of THIS region, so it covers the
          transcript + composer while leaving the header untouched. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Plain-block scroll container (like the desktop MessageStream) with an inner flex-column
            content wrapper — keeps programmatic scrollTop stick-to-bottom reliable in mobile webviews. */}
        <div ref={scrollRef} onScroll={onScroll} onClick={onContentClick} style={{ flex: 1, minHeight: 0, overflow: 'auto', background: MC.canvas }}>
          <div ref={contentRef} style={{ padding: '14px 14px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <MChatStream
              rows={props.rows}
              toolCallsUnit={copy.toolCallsUnit}
              interactions={props.interactions}
              editCopy={props.editCopy}
              editing={props.editing}
              onLongPress={props.onLongPress}
              onShowOriginal={props.onShowOriginal}
              streamKey={props.streamKey}
            />
            {props.inlineThreadCard}
            {props.systemLines?.map((t, i) => (
              <SystemLine key={i} text={t} />
            ))}
            <div style={{ height: 'calc(8px + env(safe-area-inset-bottom))', flex: 'none' }} />
          </div>
        </div>
        <MComposer
          placeholder={props.composerPlaceholder ?? (props.attachments.length > 0 ? copy.attachPlaceholder : copy.composerPh)}
          value={props.composerValue}
          onChange={props.onComposerChange}
          onSend={props.onSend}
          sendEnabled={props.sendEnabled}
          running={props.status.running}
          onStop={props.onStop}
          stopEnabled={props.stopEnabled}
          leading={props.editing || props.rejectBar ? undefined : <PlusButton onClick={props.onPlus} />}
          above={above}
          onPlus={props.onPlus}
          lineUnit={copy.lineUnit}
          charUnit={copy.charUnit}
          tone={props.editing ? 'accent' : props.rejectBar ? 'amber' : 'default'}
        />
      </div>
      {props.moreOpen && (
        <MoreMenu
          copy={copy}
          onClose={props.onMoreClose}
          onSessionId={() => {
            props.onMoreClose();
            props.onSessionIdOpen();
          }}
        />
      )}
      {props.sessionIdOpen && (
        <SessionIdSheet
          copy={copy}
          cortexId={props.cortexId}
          backendUuid={props.backendUuid}
          onClose={props.onSessionIdClose}
        />
      )}
      {props.msgMenu && props.editCopy && props.rows[props.msgMenu.rowIndex] && (
        <MsgActionMenu row={props.rows[props.msgMenu.rowIndex]} menu={props.msgMenu} copy={props.editCopy} />
      )}
      {props.originalSheet && props.editCopy && (
        <MBottomSheet onClose={props.originalSheet.onClose}>
          <div style={{ font: `600 10px ${MONO}`, color: MC.muted, letterSpacing: '.05em', padding: '0 2px 8px' }}>{props.editCopy.original}</div>
          <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 13, padding: '11px 13px', fontSize: 13, lineHeight: 1.6, color: MC.body, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', maxHeight: '50vh', overflow: 'auto' }}>
            {props.originalSheet.text}
          </div>
        </MBottomSheet>
      )}
      {props.attachMenuOpen && (
        <AttachMenu copy={copy} onClose={props.onAttachClose} onCamera={props.onCamera} onLibrary={props.onLibrary} onFile={props.onFile} />
      )}
      {props.profileSheet && (
        <ProfileSheet items={props.profileSheet.items} copy={copy} onClose={props.profileSheet.onClose} onPick={props.profileSheet.onPick} />
      )}
    </div>
  );
}
