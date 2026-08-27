// input:  Session identifiers, profile/browser choices, context usage, and menu copy
// output: Mobile chat overflow menu and bottom-sheet presentations
// pos:    Mobile chat sheet presentation seam
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useState } from 'react';
import type { SessionContextUsage } from '@cortex-agent/ui-contract';
import { ContextCompactFooter, ContextUsageDetails, contextUsageTitle, type ContextCompactAction } from '@/features/workbench/ContextUsageControl';
import { buildSessionIdRows } from '@/features/workbench/session-id';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import type { ProfileSheetItem } from './m-chat-vm';
import type { BrowserSheetItem, MChatCopy } from './MChatView.types';

export function MoreMenu({ copy, onClose, onSessionId }: {
  copy: MChatCopy;
  onClose: () => void;
  onSessionId: () => void;
}): JSX.Element {
  const items = [
    { label: copy.menuSessionId, onTap: onSessionId },
    { label: copy.menuRename, onTap: onClose },
    { label: copy.menuExport, onTap: onClose },
    { label: copy.menuArchive, onTap: onClose },
  ];
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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const doCopy = (key: string, value: string): void => {
    if (value === '—') return;
    void navigator.clipboard?.writeText(value).catch(() => {});
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((current) => current === key ? null : current), 1400);
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

function BrowserRow({ item, last, current, onPick }: {
  item: BrowserSheetItem;
  last: boolean;
  current: string | null;
  onPick: (device: string | null) => void;
}): JSX.Element {
  return (
    <div data-device={item.device ?? '__off__'} onClick={() => onPick(item.device)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: last ? undefined : '1px solid var(--proto-line-soft)', cursor: 'pointer' }}>
      <div style={{ minWidth: 0, flex: 1 }}><span style={{ font: `600 13px ${MONO}`, color: MC.ink }}>{item.label}</span>{item.sub && <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 3 }}>{item.sub}</div>}</div>
      {item.device === current && <span style={{ fontSize: 15, fontWeight: 700, color: MC.run, flex: 'none' }}>✓</span>}
    </div>
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
    <MBottomSheet onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 10px' }}><span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>{title}</span></div>
      <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 13, overflow: 'hidden' }}>{items.map((item, index) => <BrowserRow key={item.device ?? '__off__'} item={item} last={index === items.length - 1} current={current} onPick={onPick} />)}</div>
    </MBottomSheet>
  );
}
