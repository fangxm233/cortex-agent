// input:  Mobile composer modes, attachment retry/remove actions, tools, and menus
// output: Composer chrome, plus menu, profile/context tools, and slash suggestions
// pos:    Mobile chat composer presentation seam
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ReactNode } from 'react';
import type { SlashSuggestion } from '@/features/workbench/composer-slash';
import { ContextUsageRing } from '@/features/workbench/ContextUsageControl';
import { TodoRail } from '@/features/workbench/TodoRail';
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
      {props.icon}<span style={{ fontSize: 13, color: MC.ink }}>{props.label}</span>
      {props.value != null && <span style={{ marginLeft: 'auto', font: `500 10px ${MONO}`, color: MC.run }}>{props.value}</span>}
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
  return (
    <><div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 5 }} /><div style={{ position: 'absolute', left: 14, bottom: 90, width: 208, background: 'var(--panel-translucent-bg)', border: '1px solid var(--panel-translucent-border)', borderRadius: 13, boxShadow: 'var(--shadow-menu-strong)', overflow: 'hidden', zIndex: 6 }}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: MC.amberCard, border: `1px solid ${MC.amberBorder}`, borderRadius: 11, padding: '8px 8px 8px 12px', marginBottom: 7 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.amber, flex: 'none' }} /><span style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-amber-fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{props.rejectBar.title}</span>
        <div role="button" aria-label="Cancel reject" onClick={props.rejectBar.onCancel} style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: 8, background: 'var(--proto-card)', border: `1px solid ${MC.amberBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MC.amberText, fontSize: 11, flex: 'none', cursor: 'pointer' }}>✕</div>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '0 2px 8px', overflowX: 'auto' }}>{props.rejectBar.chips.map((chip) => <span key={chip} role="button" onClick={() => props.rejectBar!.onChipTap(chip)} style={{ flex: 'none', fontSize: 11, fontWeight: 600, color: MC.sub, border: '1px solid var(--proto-line-3)', background: 'var(--proto-card)', borderRadius: 999, padding: '5px 11px', cursor: 'pointer' }}>{chip}</span>)}</div>
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
      {mode}
    </>
  );
}

function ProfileChip({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1.5px solid ${MC.runBorder}`, background: MC.card, borderRadius: 999, height: 34, padding: '0 13px', boxSizing: 'border-box', flex: '0 1 auto', minWidth: 0, overflow: 'hidden', cursor: 'pointer' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: MC.run, flex: 'none' }} />
      <span style={{ minWidth: 0, font: `600 11.5px ${MONO}`, color: MC.run, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
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
      data-editable={onClick ? 'true' : 'false'} aria-label={`${label} · ${text}`}
      onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 5, flex: '0 1 auto',
        minWidth: 0, maxWidth: 150, height: 34, padding: '0 11px', boxSizing: 'border-box',
        borderRadius: 999, border: `1.5px solid ${MC.runBorder}`, background: MC.runBg,
        color: MC.run, font: `500 11px ${MONO}`, overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default' }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" style={{ flex: 'none' }}>
        <path d="M4.2 2.2v11.6" />
        <path d="M4.2 3.1h7.8L10.4 5.7l1.6 2.6H4.2z" />
      </svg>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
    </button>
  );
}

export function BrowserChip({ device, label, onClick }: {
  device: string;
  label: string;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button type="button" data-chip="browser" data-browser-device={device}
      data-editable={onClick ? 'true' : 'false'} aria-label={`${label} · ${device}`}
      onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 5, flex: '0 1 auto',
        minWidth: 0, maxWidth: 132, height: 34, padding: '0 11px', boxSizing: 'border-box',
        borderRadius: 999, border: `1.5px solid ${MC.runBorder}`, background: MC.runBg,
        color: MC.run, font: `500 11px ${MONO}`, overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default' }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.5" style={{ flex: 'none' }}>
        <circle cx="8" cy="8" r="6.5" />
        <path d="M1.5 8h13M8 1.5c-1.8 1.8-2.7 4-2.7 6.5S6.2 13.2 8 14.5c1.8-1.3 2.7-4 2.7-6.5S9.8 3.3 8 1.5z" />
      </svg>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{device}</span>
    </button>
  );
}

export function ComposerLeading({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button type="button" aria-label="Attach" onClick={onClick} style={{ flex: 'none', width: 34, height: 34, borderRadius: '50%', border: '1.5px solid var(--proto-line-3)', background: MC.card, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', color: MC.sub, lineHeight: 0, cursor: 'pointer', padding: 0 }}>
      <PlusGlyph size={15} />
    </button>
  );
}

export function ComposerTools({ props }: { props: MChatViewProps }): JSX.Element | null {
  if (props.editing || props.rejectBar) return null;
  return (
    <>
      <ProfileChip label={props.profileChipLabel} onClick={props.onOpenProfile} />
      {(props.contextUsageSupported || props.contextUsage != null) ? <span data-context-usage-position="composer-toolbar" style={{ display: 'inline-flex', flex: 'none' }}><ContextUsageRing usage={props.contextUsage ?? null} variant="mobile" lang={props.contextUsageLang ?? 'en'} onClick={props.onContextUsageOpen} data-context-compact-enabled={props.contextCompactAction ? 'true' : undefined} /></span> : null}
    </>
  );
}

export function MobileSlashMenu({ suggestions, onPick }: {
  suggestions: SlashSuggestion[];
  onPick: (suggestion: SlashSuggestion) => void;
}): JSX.Element {
  return (
    <div data-mobile-slash-menu style={{ margin: '0 0 7px', border: `1px solid ${MC.hairline}`, borderRadius: 12, background: MC.card, overflow: 'hidden', boxShadow: 'var(--shadow-menu-soft)' }}>
      {suggestions.map((suggestion) => <div key={suggestion.command} data-mobile-slash-command={suggestion.command} onClick={() => { if (!suggestion.disabled) onPick(suggestion); }} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 38, padding: '0 12px', borderBottom: `1px solid ${MC.divider}`, opacity: suggestion.disabled ? 0.45 : 1, cursor: suggestion.disabled ? 'default' : 'pointer' }}><span style={{ font: `600 11.5px ${MONO}`, color: MC.run }}>{suggestion.command}</span><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, color: MC.muted }}>{suggestion.description}</span></div>)}
    </div>
  );
}
