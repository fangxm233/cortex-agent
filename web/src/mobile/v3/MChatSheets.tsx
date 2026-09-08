// input:  Session ids, choices, context usage, copy, and shared clipboard feedback
// output: Single-action chat menu and bottom-sheet presentations
// pos:    Mobile chat sheet presentation seam
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { SessionContextUsage } from '@cortex-agent/ui-contract';
import { ContextCompactFooter, ContextUsageDetails, contextUsageTitle, type ContextCompactAction } from '@/features/workbench/ContextUsageControl';
import { buildSessionIdRows } from '@/features/workbench/session-id';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import type { ProfileSheetItem } from './m-chat-vm';
import type { BrowserSheetItem, CommissionSheetItem, MChatCopy } from './MChatView.types';
import { useClipboardFeedback } from '@/design/useClipboardFeedback';

export function MoreMenu({ copy, onClose, onSessionId }: {
  copy: MChatCopy;
  onClose: () => void;
  onSessionId: () => void;
}): JSX.Element {
  const items = [{ label: copy.menuSessionId, onTap: onSessionId }];
  return (
    <><div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 5 }} /><div style={{ position: 'absolute', top: 'calc(52px + env(safe-area-inset-top))', right: 14, width: 148, background: 'var(--panel-translucent-bg)', border: '1px solid var(--panel-translucent-border)', borderRadius: 13, boxShadow: 'var(--shadow-menu-strong)', overflow: 'hidden', zIndex: 6 }}>
      {items.map((item, index) => <div key={item.label} onClick={item.onTap} style={{ padding: '11px 14px', fontSize: 13, color: MC.ink, borderBottom: index < items.length - 1 ? '1px solid var(--proto-line-2)' : undefined, cursor: 'pointer' }}>{item.label}</div>)}
    </div></>
  );
}

interface SessionIdRowProps {
  row: { key: string; label: string; value: string };
  copy: MChatCopy;
  copied: boolean;
  onCopy: () => void;
}

function SessionIdRow({ row, copy, copied, onCopy }: SessionIdRowProps): JSX.Element {
  return (
    <div>
      <div style={{ font: `600 9.5px ${MONO}`, letterSpacing: '.05em', color: MC.muted, padding: '0 2px 5px' }}>{row.label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 11, padding: '10px 12px' }}>
        <span style={{ flex: 1, font: `500 12px ${MONO}`, color: MC.ink, wordBreak: 'break-all', userSelect: 'all' }}>{row.value}</span>
        <span role="button" onClick={onCopy} style={{ flex: 'none', font: `600 9.5px ${MONO}`, color: copied ? MC.run : MC.muted, border: `1px solid ${copied ? MC.runBorder : 'var(--proto-line-3)'}`, borderRadius: 7, padding: '4px 9px', cursor: row.value === '—' ? 'default' : 'pointer', opacity: row.value === '—' ? 0.4 : 1 }}>{copied ? copy.copied : copy.copy}</span>
      </div>
    </div>
  );
}

export function SessionIdSheet({ copy, cortexId, backendUuid, onClose }: {
  copy: MChatCopy;
  cortexId: string | null | undefined;
  backendUuid: string | null | undefined;
  onClose: () => void;
}): JSX.Element {
  const rows = buildSessionIdRows({ cortexId, backendUuid, cortexIdLabel: copy.cortexIdLabel, backendUuidLabel: copy.backendUuidLabel });
  const { copiedKey, copy: writeCopy } = useClipboardFeedback<string>();
  const doCopy = (key: string, value: string): void => {
    if (value !== '—') void writeCopy(value, key);
  };
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em', padding: '0 2px 12px' }}>{copy.sessionIdTitle}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>{rows.map((row) => <SessionIdRow key={row.key} row={row} copy={copy} copied={copiedKey === row.key} onCopy={() => doCopy(row.key, row.value)} />)}</div>
    </MBottomSheet>
  );
}

export function ContextUsageSheet({ usage, lang, compactAction, onClose }: {
  usage: SessionContextUsage | null;
  lang: 'en' | 'zh';
  compactAction?: ContextCompactAction;
  onClose: () => void;
}): JSX.Element {
  return (
    <MBottomSheet onClose={onClose}>
      <div data-mobile-context-usage-sheet="true">
        <div style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em', padding: '0 2px 10px' }}>{contextUsageTitle(lang)}</div>
        <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 13, padding: '12px 13px' }}><ContextUsageDetails usage={usage} lang={lang} /></div>
        {compactAction ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 2px 0' }}><ContextCompactFooter action={compactAction} lang={lang} /></div> : null}
      </div>
    </MBottomSheet>
  );
}

function ProfileRow({ item, last, copy, onPick }: {
  item: ProfileSheetItem;
  last: boolean;
  copy: MChatCopy;
  onPick: (name: string) => void;
}): JSX.Element {
  return (
    <div onClick={() => onPick(item.name)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: last ? undefined : '1px solid var(--proto-line-soft)', cursor: 'pointer' }}>
      <div style={{ minWidth: 0, flex: 1 }}><div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span style={{ font: `600 13px ${MONO}`, color: MC.ink }}>{item.name}</span>{item.current && <span style={{ fontSize: 9.5, fontWeight: 600, padding: '1.5px 7px', borderRadius: 999, background: MC.runBg, color: MC.run }}>{copy.profileCurrent}</span>}</div><div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 3 }}>{item.sub}</div></div>
      {item.current && <span style={{ fontSize: 15, fontWeight: 700, color: MC.run, flex: 'none' }}>✓</span>}
    </div>
  );
}

export function ProfileSheet({ items, copy, onClose, onPick }: {
  items: ProfileSheetItem[];
  copy: MChatCopy;
  onClose: () => void;
  onPick: (name: string) => void;
}): JSX.Element {
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 10px' }}><span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>{copy.profileTitle}</span><span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint }}>{copy.profileSubtitle}</span></div>
      <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 13, overflow: 'hidden' }}>{items.map((item, index) => <ProfileRow key={item.name} item={item} last={index === items.length - 1} copy={copy} onPick={onPick} />)}</div>
      <div style={{ font: `400 9.5px ${MONO}`, color: MC.faint, padding: '9px 4px 0' }}>{copy.profileFooter}</div>
    </MBottomSheet>
  );
}

/** One creation-time option (a browser device, a commission). `attr` is the test/selector hook, kept
 *  per-surface so the two sheets stay individually addressable while sharing this markup. */
function OptionRow({ item, attr, last, current, onPick }: {
  item: { value: string | null; label: string; sub: string };
  attr: 'data-device' | 'data-commission-option';
  last: boolean;
  current: string | null;
  onPick: (value: string | null) => void;
}): JSX.Element {
  return (
    <div {...{ [attr]: item.value ?? '__off__' }} onClick={() => onPick(item.value)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: last ? undefined : '1px solid var(--proto-line-soft)', cursor: 'pointer' }}>
      <div style={{ minWidth: 0, flex: 1 }}><span style={{ font: `600 13px ${MONO}`, color: MC.ink }}>{item.label}</span>{item.sub && <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 3 }}>{item.sub}</div>}</div>
      {item.value === current && <span style={{ fontSize: 15, fontWeight: 700, color: MC.run, flex: 'none' }}>✓</span>}
    </div>
  );
}

function OptionSheet({ items, attr, title, current, onClose, onPick }: {
  items: Array<{ value: string | null; label: string; sub: string }>;
  attr: 'data-device' | 'data-commission-option';
  title: string;
  current: string | null;
  onClose: () => void;
  onPick: (value: string | null) => void;
}): JSX.Element {
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 10px' }}><span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>{title}</span></div>
      <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 13, overflow: 'hidden' }}>{items.map((item, index) => <OptionRow key={item.value ?? '__off__'} item={item} attr={attr} last={index === items.length - 1} current={current} onPick={onPick} />)}</div>
    </MBottomSheet>
  );
}

export function BrowserSheet({ items, title, current, onClose, onPick }: {
  items: BrowserSheetItem[];
  title: string;
  current: string | null;
  onClose: () => void;
  onPick: (device: string | null) => void;
}): JSX.Element {
  return (
    <OptionSheet
      items={items.map((i) => ({ value: i.device, label: i.label, sub: i.sub }))}
      attr="data-device" title={title} current={current} onClose={onClose} onPick={onPick}
    />
  );
}

export function CommissionSheet({ items, title, current, onClose, onPick }: {
  items: CommissionSheetItem[];
  title: string;
  current: string | null;
  onClose: () => void;
  onPick: (value: string | null) => void;
}): JSX.Element {
  return (
    <OptionSheet
      items={items} attr="data-commission-option"
      title={title} current={current} onClose={onClose} onPick={onPick}
    />
  );
}
