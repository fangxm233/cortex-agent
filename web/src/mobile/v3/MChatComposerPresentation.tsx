// input:  React, mobile presentation props, shared view models
// output: MChatComposerPresentation
// pos:    Mobile composer controls and glass attachment menu
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import type { SlashSuggestion } from '@/features/workbench/composer-slash';
import { TodoRail } from '@/features/workbench/TodoRail';
import { WaitRail } from '@/features/workbench/WaitRail';
import { PlusGlyph } from '@/design';
import { MC, MONO } from '@/mobile/ui/kit';
import { ComposerAttachmentStrip } from './MChatAttachments';
import { EditBar } from './MChatMessageActions';
import type { MChatCopy, MChatViewProps } from './MChatView.types';

function CameraIcon(): JSX.Element {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={MC.ink} strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="2" /><circle cx="8" cy="8.7" r="2.6" /><path d="M5.5 4l1-1.7h3l1 1.7" /></svg>;
}

function LibraryIcon(): JSX.Element {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={MC.ink} strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="2.5" /><circle cx="6" cy="6" r="1.3" /><path d="M2.5 11.5 6 8.5l2.5 2 3-3 2 2" /></svg>;
}

function FileIcon(): JSX.Element {
  return <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke={MC.ink} strokeWidth="1.4"><path d="M3 1.5h5.5L11.5 4v8.5h-8.5z" /><path d="M8.5 1.5V4H11" /></svg>;
}

function BrowserIcon(): JSX.Element {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={MC.ink} strokeWidth="1.5"><circle cx="8" cy="8" r="6.5" /><path d="M1.5 8h13M8 1.5c-1.8 1.8-2.7 4-2.7 6.5S6.2 13.2 8 14.5c1.8-1.3 2.7-4 2.7-6.5S9.8 3.3 8 1.5z" /></svg>;
}

function CommandsIcon(): JSX.Element {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={MC.ink} strokeWidth="1.6"><path d="M10.5 2.5 5.5 13.5" /></svg>;
}

interface AttachMenuItemProps {
  label: string;
  icon: ReactNode;
  onTap?: () => void;
  onClose: () => void;
  last?: boolean;
  value?: string;
  itemKey?: string;
}

function AttachMenuItem(props: AttachMenuItemProps): JSX.Element {
  const tap = props.onTap ? (): void => { props.onTap?.(); props.onClose(); } : undefined;
  const reportsOnly = props.itemKey === 'browser' || props.itemKey === 'commission';
  return (
    <div data-plus-item={props.itemKey} data-editable={reportsOnly ? (props.onTap ? 'true' : 'false') : undefined} onClick={tap} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', borderBottom: props.last ? undefined : '1px solid var(--proto-line-2)', cursor: props.onTap ? 'pointer' : 'default', opacity: props.onTap ? 1 : 0.6 }}>
      {props.icon}<span style={{ fontSize: 13, color: MC.ink, minWidth: 0, overflowWrap: 'anywhere' }}>{props.label}</span>
      {props.value != null && <span style={{ marginLeft: 'auto', font: `500 11px ${MONO}`, color: MC.run, minWidth: 0, maxWidth: '55%', overflowWrap: 'anywhere', textAlign: 'right' }}>{props.value}</span>}
    </div>
  );
}

export function AttachMenu({ copy, onClose, onCamera, onLibrary, onFile, browser, commission, onCommands }: {
  copy: MChatCopy;
  onClose: () => void;
  onCamera: () => void;
  onLibrary: () => void;
  onFile: () => void;
  browser?: { device: string | null; onOpen?: () => void };
  commission?: { label: string | null; onOpen?: () => void };
  onCommands: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Mounted beside (not inside) the blurred composer, outside the isolated
  // transcript; the small menu samples the route. Preserve composer clearance.
  return (
    <><div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 5 }} /><div style={{ position: 'absolute', left: 12, bottom: 'calc(124px + env(safe-area-inset-bottom))', width: 208, background: 'var(--material-overlay-bg)', backdropFilter: MC.glassFilter, WebkitBackdropFilter: MC.glassFilter, border: '1px solid var(--panel-translucent-border)', borderRadius: 'var(--r-card)', boxShadow: 'var(--material-overlay-shadow)', overflow: 'hidden', zIndex: 6 }}>
      <AttachMenuItem label={copy.attachCamera} onTap={onCamera} onClose={onClose} icon={<CameraIcon />} />
      <AttachMenuItem label={copy.attachLibrary} onTap={onLibrary} onClose={onClose} icon={<LibraryIcon />} />
      <AttachMenuItem label={copy.attachFile} onTap={onFile} onClose={onClose} icon={<FileIcon />} />
      {browser && <AttachMenuItem label={copy.attachBrowser} onTap={browser.onOpen} onClose={onClose} icon={<BrowserIcon />} itemKey="browser" value={browser.device ?? undefined} />}
      {commission && <AttachMenuItem label={copy.attachCommission} onTap={commission.onOpen} onClose={onClose} icon={<CommissionIcon />} itemKey="commission" value={commission.label ?? undefined} />}
      <AttachMenuItem label={copy.attachCommands} onTap={onCommands} onClose={onClose} icon={<CommandsIcon />} itemKey="commands" last />
    </div></>
  );
}

function RejectHeader({ props }: { props: MChatViewProps }): JSX.Element | null {
  if (!props.rejectBar) return null;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: MC.amberCard, border: `1px solid ${MC.amberBorder}`, borderRadius: 'var(--r-control)', padding: '8px 8px 8px 12px', marginBottom: 7 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.amber, flex: 'none' }} /><span style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-amber-fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{props.rejectBar.title}</span>
        <div role="button" aria-label="Cancel reject" onClick={props.rejectBar.onCancel} style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: 'var(--r-chip)', background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', border: `1px solid ${MC.amberBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MC.amberText, fontSize: 11, flex: 'none', cursor: 'pointer' }}>✕</div>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '0 2px 8px', overflowX: 'auto' }}>{props.rejectBar.chips.map((chip) => <span key={chip} role="button" onClick={() => props.rejectBar!.onChipTap(chip)} style={{ flex: 'none', fontSize: 11, fontWeight: 600, color: MC.sub, border: '1px solid var(--proto-line-3)', background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', borderRadius: 'var(--r-pill)', padding: '5px 11px', cursor: 'pointer' }}>{chip}</span>)}</div>
    </>
  );
}

export function ComposerAbove({ props }: { props: MChatViewProps }): JSX.Element {
  let mode: ReactNode = <ComposerAttachmentStrip attachments={props.attachments} onRetry={props.onRetryAttachment} onRemove={props.onRemoveAttachment} />;
  if (props.editing && props.editCopy) mode = <EditBar title={props.editCopy.editBarTitle} onCancel={props.editing.onCancel} />;
  else if (props.rejectBar) mode = <RejectHeader props={props} />;
  return (
    <>
      {props.sessionId && props.todos ? <TodoRail sessionId={props.sessionId} todos={props.todos} lang={props.todoLang ?? 'en'} /> : null}
      {props.sessionId && props.waitpoints ? (
        <WaitRail
          sessionId={props.sessionId}
          lang={props.todoLang ?? 'en'}
          waitpoints={props.waitpoints.waitpoints}
          onCancel={props.waitpoints.cancel}
          cancelling={props.waitpoints.cancelling}
        />
      ) : null}
      {mode}
    </>
  );
}

/** The quiet outline both toolbar capsules wear. Chips sit on a glass card now, so an opaque fill
 *  would punch a hole through the blur behind them. */
const composerChipStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, border: '1px solid var(--proto-line-3)',
  background: 'transparent', borderRadius: 'var(--r-pill)', height: 34, padding: '0 12px',
  boxSizing: 'border-box', minWidth: 0, overflow: 'hidden', cursor: 'pointer',
};

/** Model and thinking level share one capsule with no separator between them — on a phone the
 *  toolbar has no room for punctuation, so ink weight does the separating: the model in the body
 *  tier, the level a step fainter beside it. The level is also what goes first when the row runs out
 *  of width (it shrinks far faster than the model name), since the model is the fact worth keeping
 *  on screen. */
function SelectionChip({ label, sub, onClick }: { label: string; sub?: string | null; onClick: () => void }): JSX.Element {
  return (
    <button type="button" data-chip="selection" aria-label={sub ? `${label} · ${sub}` : label} onClick={onClick} style={{ ...composerChipStyle, flex: '0 1 auto' }}>
      <span style={{ flex: '0 1 auto', minWidth: 0, font: `500 11.5px ${MONO}`, color: MC.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {sub ? (
        <span data-chip-sub style={{ flex: '0 12 auto', minWidth: 0, font: `500 11.5px ${MONO}`, color: MC.muted, whiteSpace: 'nowrap', overflow: 'hidden' }}>{sub}</span>
      ) : null}
    </button>
  );
}

/** The environment capsule, immediately left of the engine one: where the turn runs, before what
 *  runs it. It names the agent outright — the environment decides whether the session has the
 *  skills and rules for the job at all, which is worth a glance rather than a sheet visit. A step
 *  fainter while the conversation is only following the host's default, so a name it chose for
 *  itself reads differently from a name it merely fell back to. It also yields width first: of the
 *  two capsules the model is the one that must stay legible on a phone. */
function AgentChip({ axis, label, followingDefault, onClick }: {
  /** What the capsule IS, for the screen reader — the name alone would not say. */
  axis: string;
  label: string;
  followingDefault: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-chip="agent"
      data-agent-following-default={followingDefault ? 'true' : 'false'}
      aria-label={`${axis} · ${label}`}
      onClick={onClick}
      style={{ ...composerChipStyle, flex: '0 3 auto' }}
    >
      <span style={{
        minWidth: 0, font: `500 11.5px ${MONO}`, color: followingDefault ? MC.muted : MC.muted,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {label}
      </span>
    </button>
  );
}

/** The pennant mark a commission carries everywhere in the UI — rail, board, banner, capsule. */
function CommissionIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={MC.muted} strokeWidth="1.4"
      strokeLinejoin="round" strokeLinecap="round" style={{ flex: 'none' }}>
      <path d="M4.2 2.2v11.6" />
      <path d="M4.2 3.1h7.8L10.4 5.7l1.6 2.6H4.2z" />
    </svg>
  );
}

/** Same capsule as the browser's, for the same reason: after the sheet closes there would otherwise
 *  be nothing on screen saying this conversation is a commitment with a contract behind it. */
export function CommissionChip({ value, text, label, onClick }: {
  value: string;
  text: string;
  label: string;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button type="button" data-chip="commission" data-commission-value={value}
      data-editable={onClick ? 'true' : 'false'} aria-label={`${label} · ${text}`} title={`${label} · ${text}`}
      onClick={onClick} style={{ ...modeChipStyle, cursor: onClick ? 'pointer' : 'default' }}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" style={{ flex: 'none' }}>
        <path d="M4.2 2.2v11.6" />
        <path d="M4.2 3.1h7.8L10.4 5.7l1.6 2.6H4.2z" />
      </svg>
    </button>
  );
}

/** Browser and commission report as bare icon keys, the size of ＋. The phone toolbar cannot seat
 *  two named capsules next to the model chip and the send keys, and of the three the model is the
 *  one that must stay legible — so the device/commission name moves into the sheet the key opens
 *  (and into its aria-label/tooltip), while the lit key alone says the mode is on. */
const modeChipStyle: CSSProperties = {
  flex: 'none', width: 34, height: 34, padding: 0, boxSizing: 'border-box', borderRadius: '50%',
  border: `1.5px solid ${MC.runBorder}`, background: MC.runBg, color: MC.run,
  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0,
};

export function BrowserChip({ device, label, onClick }: {
  device: string;
  label: string;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button type="button" data-chip="browser" data-browser-device={device}
      data-editable={onClick ? 'true' : 'false'} aria-label={`${label} · ${device}`} title={`${label} · ${device}`}
      onClick={onClick} style={{ ...modeChipStyle, cursor: onClick ? 'pointer' : 'default' }}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.5" style={{ flex: 'none' }}>
        <circle cx="8" cy="8" r="6.5" />
        <path d="M1.5 8h13M8 1.5c-1.8 1.8-2.7 4-2.7 6.5S6.2 13.2 8 14.5c1.8-1.3 2.7-4 2.7-6.5S9.8 3.3 8 1.5z" />
      </svg>
    </button>
  );
}

export function ComposerLeading({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button type="button" aria-label="Attach" onClick={onClick} style={{ flex: 'none', width: 34, height: 34, borderRadius: '50%', border: '1px solid var(--proto-line-3)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', color: MC.sub, lineHeight: 0, cursor: 'pointer', padding: 0 }}>
      <PlusGlyph size={15} />
    </button>
  );
}

/** The right-hand end of the composer toolbar. Context usage used to sit here too; it moved to the
 *  header, next to ⋯ — it reports on the session rather than on the message being written, and the
 *  width it took was width the engine chip needed once browser/commission keys joined the row. */
export function ComposerTools({ props }: { props: MChatViewProps }): JSX.Element | null {
  if (props.editing || props.rejectBar) return null;
  return (
    <>
      {props.agentChip && props.onOpenAgent ? (
        <AgentChip
          axis={props.copy.selectionAgent}
          label={props.agentChip.label}
          followingDefault={props.agentChip.followingDefault}
          onClick={props.onOpenAgent}
        />
      ) : null}
      <SelectionChip label={props.selectionChipLabel} sub={props.selectionChipSub} onClick={props.onOpenSelection} />
    </>
  );
}

export function MobileSlashMenu({ suggestions, onPick }: {
  suggestions: SlashSuggestion[];
  onPick: (suggestion: SlashSuggestion) => void;
}): JSX.Element {
  return (
    <div data-mobile-slash-menu style={{ margin: '0 0 7px', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', background: 'var(--material-inset-bg)', overflow: 'hidden', boxShadow: 'var(--material-control-shadow)' }}>
      {suggestions.map((suggestion) => <div key={suggestion.command} data-mobile-slash-command={suggestion.command} onClick={() => { if (!suggestion.disabled) onPick(suggestion); }} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, padding: '0 12px', borderBottom: `1px solid ${MC.divider}`, opacity: suggestion.disabled ? 0.45 : 1, cursor: suggestion.disabled ? 'default' : 'pointer' }}><span style={{ font: `600 11.5px ${MONO}`, color: MC.run }}>{suggestion.command}</span><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: MC.muted }}>{suggestion.description}</span></div>)}
    </div>
  );
}
