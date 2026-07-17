// @ds-adherence-ignore -- mobile v3 chat surface, chrome extracted 1:1 from scheme-mobile.dc.html
// (1b L136-168 · 1o L753-786 · 1p L799-845 · 5a reject composer L200-218). Raw px/hex/font/svg by
// design §8.3 — the mobile palette is not in the light `proto.*` token set. Pure + presentational:
// every field is a prop, no tRPC. The container (MChatScreen) owns data + mutations + live sync.
// Interaction cards (6a plan / 5b ask / 4a-c sealed) live in MInteractionCards.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import type { ChatRow, Attachment } from '@/features/workbench/transcript-vm';
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
import { MAskCard, MPlanCard, M_INT_COPY, type MIntCopy } from './MInteractionCards';
import type { ChatHeaderStatus, ProfileSheetItem, PendingAttachmentVM } from './m-chat-vm';

export interface MChatCopy {
  composerPh: string;
  toolCallsUnit: string;
  menuRename: string;
  menuExport: string;
  menuArchive: string;
  attachCamera: string;
  attachLibrary: string;
  attachFile: string;
  attachFootnote: string;
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

// ── 1b header — ‹ back · title + status line · ⋯ menu ─────────────────────────
export function MChatHeader({
  title,
  status,
  onBack,
  onMore,
}: {
  title: string;
  status: ChatHeaderStatus;
  onBack: () => void;
  onMore: () => void;
}): JSX.Element {
  return (
    <MDrillHeader onBack={onBack} trailing={<MMoreButton onClick={onMore} />}>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 650,
            color: MC.ink,
            letterSpacing: '-.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            font: `400 10px ${MONO}`,
            // 6a/5a header: a pending interaction turns the whole status line amber.
            color: status.tone === 'waiting' ? MC.amberText : MC.muted,
            marginTop: 1,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: status.tone === 'waiting' ? MC.amber : status.running ? MC.run : '#D9DCE3',
              animation: status.running ? 'cxpulse 1.6s ease-in-out infinite' : undefined,
            }}
          />
          {status.text}
        </div>
      </div>
    </MDrillHeader>
  );
}

// The inert ⋯ menu (重命名/导出/归档 — no backend op; honest affordance).
export function MoreMenu({ copy, onClose }: { copy: MChatCopy; onClose: () => void }): JSX.Element {
  const items = [copy.menuRename, copy.menuExport, copy.menuArchive];
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
        {items.map((label, i) => (
          <div
            key={label}
            onClick={onClose}
            style={{
              padding: '11px 14px',
              fontSize: 13,
              color: MC.ink,
              borderBottom: i < items.length - 1 ? '1px solid #EFF1F5' : undefined,
              cursor: 'pointer',
            }}
          >
            {label}
          </div>
        ))}
      </div>
    </>
  );
}

// ── attachment tiles (scheme 1o L762-766) ─────────────────────────────────────
const STRIPES = 'repeating-linear-gradient(45deg,#E9EBF0 0 6px,#F4F5F8 6px 12px)';

function AttachmentTile({ a }: { a: Attachment }): JSX.Element {
  const tap = () => void downloadFile(a.path, a.name);
  if (a.type === 'image' || a.type === 'video') {
    return (
      <div
        role="button"
        onClick={tap}
        style={{
          width: a.type === 'video' ? 104 : 74,
          height: 74,
          borderRadius: 12,
          background: STRIPES,
          position: 'relative',
          overflow: 'hidden',
          flex: 'none',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 7,
            bottom: 6,
            font: `500 8px ${MONO}`,
            color: MC.muted,
            background: 'rgba(255,255,255,.85)',
            padding: '1px 5px',
            borderRadius: 4,
          }}
        >
          {a.type === 'video' ? `▶ ${a.name}` : a.name}
        </span>
      </div>
    );
  }
  return (
    <div
      role="button"
      onClick={tap}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: '#fff',
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

function AttachmentGroup({ attachments }: { attachments: Attachment[] }): JSX.Element {
  return (
    <div style={{ alignSelf: 'flex-end', display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#98A1B0', flexWrap: 'wrap', cursor: 'pointer' }}
      >
        <span style={{ fontSize: 8.5 }}>▸</span>
        <span>
          {count} {unit}
        </span>
        {chips.names.map((name, i) => (
          <span key={i} style={{ font: `400 10px ${MONO}`, background: '#fff', border: '1px solid #EFF1F5', padding: '1px 6px', borderRadius: 4 }}>
            {name}
          </span>
        ))}
        {chips.overflow > 0 && <span>+{chips.overflow}</span>}
      </div>
    );
  }
  return (
    <div style={{ background: '#FBFBFC', border: '1px solid #EFF1F5', borderRadius: 8, overflow: 'hidden' }}>
      <div onClick={() => setExpanded(false)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#98A1B0', padding: '6px 11px', cursor: 'pointer' }}>
        <span style={{ fontSize: 8.5 }}>▾</span>
        <span>
          {count} {unit}
        </span>
      </div>
      {calls.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5.5px 11px', borderTop: '1px solid #F3F4F7' }}>
          <span style={{ font: `600 9px ${MONO}`, color: '#5B6472', background: '#F1F2F5', padding: '1.5px 7px', borderRadius: 5, flex: 'none' }}>{c.kind}</span>
          <span style={{ font: `400 10.5px ${MONO}`, color: MC.body, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{c.input}</span>
        </div>
      ))}
    </div>
  );
}

// ── the message stream (reuses ChatMarkdown; renders attachments above/below bubbles) ──

const NOOP = (): void => {};

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
  const color = v.tone === 'rejected' ? '#C03D33' : v.tone === 'inactive' ? '#98A1B0' : MC.done;
  const icon = v.tone === 'rejected' ? '✗' : v.tone === 'inactive' ? '◌' : '✓';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', background: '#fff', border: '1px solid #EFF1F5', borderRadius: 10, opacity: v.tone === 'inactive' ? 0.6 : 0.75 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color, flexShrink: 0 }}>{icon} {v.label}</span>
      <span style={{ fontSize: 11.5, color: MC.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.text}</span>
    </div>
  );
}

export function MChatStream({ rows, toolCallsUnit, interactions }: { rows: ChatRow[]; toolCallsUnit: string; interactions?: MChatInteractions }): JSX.Element {
  return (
    <>
      {rows.map((row, i) => (
        <Fragment key={row.kind === 'interaction' && row.detail ? `int-${row.detail.id}` : i}>
          {row.kind === 'divider' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, height: 1, background: '#E3E5EA' }} />
              <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.06em', color: MC.faint }}>{row.text}</div>
              <div style={{ flex: 1, height: 1, background: '#E3E5EA' }} />
            </div>
          )}
          {row.kind === 'user' && (
            <>
              {row.attachments && row.attachments.length > 0 && <AttachmentGroup attachments={row.attachments} />}
              <div
                style={{
                  alignSelf: 'flex-end',
                  maxWidth: '82%',
                  background: MC.ink,
                  color: '#fff',
                  borderRadius: '16px 16px 4px 16px',
                  padding: '9px 13px',
                  fontSize: 13.5,
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'break-word',
                  wordBreak: 'break-word',
                }}
              >
                {row.text}
              </div>
            </>
          )}
          {row.kind === 'tools' && <ToolCallsRow count={row.count} calls={row.calls} unit={toolCallsUnit} />}
          {row.kind === 'assistant' && (
            <div style={{ fontSize: 13.5, lineHeight: 1.65, color: MC.body, minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
              {/* dropTrailingHr — assistant messages often end with a `---` separator; on mobile the
                  trailing horizontal rule reads as dangling cruft, so it is stripped. No streaming
                  caret: the blinking output-position block was removed by request. */}
              <ChatMarkdown text={row.text} dropTrailingHr />
              {row.attachments && row.attachments.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <AttachmentGroup attachments={row.attachments} />
                </div>
              )}
            </div>
          )}
          {row.kind === 'interaction' && <MInteractionRow row={row} interactions={interactions} />}
        </Fragment>
      ))}
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
        background: '#fff',
        border: '1px solid #EFF1F5',
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
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', borderBottom: last ? undefined : '1px solid #EFF1F5', cursor: 'pointer' }}
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
          bottom: 150,
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

// Composer attachment chip (scheme 1o L773-774) — filename + upload progress / done ✓.
function ComposerChip({ a, onRemove }: { a: PendingAttachmentVM; onRemove: () => void }): JSX.Element {
  const uploading = a.status === 'uploading';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: uploading ? 7 : 6, background: '#fff', border: `1px solid ${uploading ? MC.runBorder : MC.hairline}`, borderRadius: 9, padding: '5px 9px', flex: 'none' }}>
      <span style={{ font: `500 10px ${MONO}`, color: MC.body }}>{a.name}</span>
      {uploading ? (
        <>
          <div style={{ width: 34, height: 4, borderRadius: 999, background: '#EFF1F5', overflow: 'hidden' }}>
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
      <div style={{ background: '#fff', border: `1px solid ${MC.hairline}`, borderRadius: 13, overflow: 'hidden' }}>
        {items.map((it, i) => (
          <div
            key={it.name}
            onClick={() => onPick(it.name)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: i < items.length - 1 ? '1px solid #F3F4F7' : undefined, cursor: 'pointer' }}
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
      style={{ flex: 'none', width: 46, height: 46, borderRadius: 14, border: `1.5px solid ${MC.run}`, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', color: MC.run, fontSize: 22, fontWeight: 300, cursor: 'pointer' }}
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
      style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #E3E6F5', background: '#fff', borderRadius: 999, padding: '4px 10px', flex: 'none', cursor: 'pointer' }}
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
  // stream slots
  inlineThreadCard?: ReactNode;
  systemLines?: string[];
  // Interaction cards live inline in `rows` (transcript entities); this supplies the per-card
  // handlers + session-local answer state (scheme 6a/5b/4a-c).
  interactions?: MChatInteractions;
  // 5a reject mode — amber context bar + reason chips above the composer; composer ring amber.
  rejectBar?: MRejectBar;
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

  // 5a reject mode replaces the composer chrome: amber context bar (+ ✕ cancel) + reason chips
  // (scheme L200-211). Otherwise: attachment chips + profile chip.
  const above = props.rejectBar ? (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: MC.amberCard, border: `1px solid ${MC.amberBorder}`, borderRadius: 11, padding: '8px 8px 8px 12px', marginBottom: 7 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.amber, flex: 'none' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6B5A1E', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{props.rejectBar.title}</span>
        <div
          role="button"
          aria-label="Cancel reject"
          onClick={props.rejectBar.onCancel}
          style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: 8, background: '#fff', border: `1px solid ${MC.amberBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MC.amberText, fontSize: 11, flex: 'none', cursor: 'pointer' }}
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
            style={{ flex: 'none', fontSize: 11, fontWeight: 600, color: MC.sub, border: '1px solid #D9DCE3', background: '#fff', borderRadius: 999, padding: '5px 11px', cursor: 'pointer' }}
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
      {/* Composer chrome above the input: the profile chip only. The running/idle status line was
          removed — that readout now lives in the header (see chatHeaderStatus). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 7px' }}>
        <ProfileChip label={props.profileChipLabel} onClick={props.onOpenProfile} />
      </div>
    </>
  );

  return (
    <div
      data-screen-label="1b 会话详情"
      style={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', background: MC.canvas }}
    >
      <MChatHeader title={props.title} status={props.status} onBack={props.onBack} onMore={props.onMoreToggle} />
      {/* Body region — a position:relative frame holding the scroll transcript + composer. The
          full-screen editor (2b) mounts as an absolute overlay of THIS region, so it covers the
          transcript + composer while leaving the header untouched. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Plain-block scroll container (like the desktop MessageStream) with an inner flex-column
            content wrapper — keeps programmatic scrollTop stick-to-bottom reliable in mobile webviews. */}
        <div ref={scrollRef} onScroll={onScroll} onClick={onContentClick} style={{ flex: 1, minHeight: 0, overflow: 'auto', background: MC.canvas }}>
          <div style={{ padding: '14px 14px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <MChatStream rows={props.rows} toolCallsUnit={copy.toolCallsUnit} interactions={props.interactions} />
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
          leading={props.rejectBar ? undefined : <PlusButton onClick={props.onPlus} />}
          above={above}
          onPlus={props.onPlus}
          lineUnit={copy.lineUnit}
          charUnit={copy.charUnit}
          tone={props.rejectBar ? 'amber' : 'default'}
        />
        {props.attachments.length > 0 && (
          <div style={{ font: `400 9px ${MONO}`, color: MC.faint, padding: '0 16px 6px', marginTop: -28 }}>{copy.attachFootnote}</div>
        )}
      </div>
      {props.moreOpen && <MoreMenu copy={copy} onClose={props.onMoreClose} />}
      {props.attachMenuOpen && (
        <AttachMenu copy={copy} onClose={props.onAttachClose} onCamera={props.onCamera} onLibrary={props.onLibrary} onFile={props.onFile} />
      )}
      {props.profileSheet && (
        <ProfileSheet items={props.profileSheet.items} copy={copy} onClose={props.profileSheet.onClose} onPick={props.profileSheet.onPick} />
      )}
    </div>
  );
}
