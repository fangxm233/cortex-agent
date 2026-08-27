// input:  Held mobile chat row, edit state, copy labels, and bubble anchor
// output: Long-press message action overlay, copy action, and edit context bar
// pos:    Mobile chat message-action presentation seam
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { messageTimeLabel, type ChatRow } from '@/features/workbench/transcript-vm';
import { MC, MONO } from '@/mobile/ui/kit';
import { msgMenuGroupTop, MSG_MENU_SAFE_BOTTOM, MSG_MENU_SAFE_TOP } from './m-chat-vm';
import type { MChatEditCopy, MMsgMenu } from './MChatView.types';

export function longPressHandlers(fire: (anchorTop: number) => void): {
  onTouchStart: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchEnd: () => void;
  onTouchMove: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const topOf = (element: { getBoundingClientRect: () => { top: number } }): number => element.getBoundingClientRect().top;
  const clear = (): void => { if (timer) clearTimeout(timer); };
  return {
    onTouchStart: (event) => { const element = event.currentTarget; timer = setTimeout(() => fire(topOf(element)), 450); },
    onTouchEnd: clear,
    onTouchMove: clear,
    onContextMenu: (event) => { event.preventDefault(); fire(topOf(event.currentTarget)); },
  };
}

export function AssistantCopyButton({ text, label, copiedLabel }: {
  text: string;
  label: string;
  copiedLabel: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button type="button" data-assistant-turn-copy="true" aria-label={copied ? copiedLabel : label} title={copied ? copiedLabel : label} onClick={copy} style={{ width: 28, height: 26, padding: 0, border: 0, background: 'transparent', color: copied ? 'var(--proto-success)' : MC.muted, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
      {copied ? '✓' : <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="4.5" y="4.5" width="8" height="8" rx="1.5" /><path d="M2.5 9.5V3.5a1 1 0 0 1 1-1h6" /></svg>}
    </button>
  );
}

export function AssistantTurnCopyAction({ text, label, copiedLabel }: {
  text?: string;
  label: string;
  copiedLabel: string;
}): JSX.Element | null {
  if (!text) return null;
  return (
    <div style={{ height: 26, marginTop: 4, display: 'flex', alignItems: 'center' }}>
      <AssistantCopyButton text={text} label={label} copiedLabel={copiedLabel} />
    </div>
  );
}

function MsgMenuIcon({ kind }: { kind: 'copy' | 'edit' }): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke={MC.muted} strokeWidth="1.4" style={{ marginLeft: 'auto' }}>
      {kind === 'copy'
        ? <><rect x="4.5" y="4.5" width="8" height="8" rx="1.5" /><path d="M2.5 9.5V3.5a1 1 0 0 1 1-1h6" /></>
        : <><path d="M2.5 11.5l.6-2.6 6.4-6.4a1.3 1.3 0 0 1 1.8 0l.2.2a1.3 1.3 0 0 1 0 1.8L5.1 10.9z" /><path d="M8.6 3.4l2 2" /></>}
    </svg>
  );
}

function MsgMenuItem({ label, icon, onTap, onClose, disabled, divided }: {
  label: string;
  icon: 'copy' | 'edit';
  onTap?: () => void;
  onClose: () => void;
  disabled?: boolean;
  divided?: boolean;
}): JSX.Element {
  const tap = disabled ? undefined : (): void => { onTap?.(); onClose(); };
  return (
    <div role="button" onClick={tap} style={{ display: 'flex', alignItems: 'center', height: 46, padding: '0 15px', fontSize: 14.5, color: MC.ink, opacity: disabled ? 0.35 : 1, cursor: disabled ? 'default' : 'pointer', borderTop: divided ? `1px solid ${MC.divider}` : undefined }}>
      {label}<MsgMenuIcon kind={icon} />
    </div>
  );
}

function HeldBubbleCopy({ isUser, text }: { isUser: boolean; text: string }): JSX.Element {
  const shared = { flex: '0 1 auto', minHeight: 0, overflow: 'hidden', padding: '9px 13px', fontSize: 13.5, boxShadow: 'var(--shadow-context-menu)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' } as const;
  if (isUser) {
    return <div style={{ ...shared, maxWidth: '82%', background: MC.ink, color: 'var(--ink-solid-fg)', borderRadius: '16px 16px 4px 16px', lineHeight: 1.55 }}>{text}</div>;
  }
  return <div style={{ ...shared, maxWidth: '88%', background: 'var(--proto-card)', color: MC.body, borderRadius: 14, lineHeight: 1.6 }}>{text}</div>;
}

function useMsgMenuTop(anchorTop: number | null | undefined): {
  overlayRef: React.RefObject<HTMLDivElement>;
  groupRef: React.RefObject<HTMLDivElement>;
  top: number | null;
} {
  const overlayRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const group = groupRef.current;
    if (!overlay || !group) return;
    const box = overlay.getBoundingClientRect();
    setTop(msgMenuGroupTop({ anchorTop: anchorTop ?? null, overlayTop: box.top, overlayHeight: box.height, groupHeight: group.getBoundingClientRect().height }));
  }, [anchorTop]);
  return { overlayRef, groupRef, top };
}

function MessageMenuCard({ menu, copy }: { menu: MMsgMenu; copy: MChatEditCopy }): JSX.Element {
  return (
    <div onClick={(event) => event.stopPropagation()} style={{ flex: 'none', width: 196, background: MC.card, border: `1px solid ${MC.cardBorder}`, borderRadius: 13, boxShadow: 'var(--shadow-menu-floating)', overflow: 'hidden' }}>
      <MsgMenuItem label={copy.menuCopy} icon="copy" onTap={menu.onCopy} onClose={menu.onClose} />
      {menu.onEdit && <MsgMenuItem label={copy.menuEdit} icon="edit" onTap={menu.onEdit} onClose={menu.onClose} disabled={menu.editDisabled} divided />}
    </div>
  );
}

function ActionGroup({ row, menu, copy, groupRef, top }: {
  row: ChatRow;
  menu: MMsgMenu;
  copy: MChatEditCopy;
  groupRef: React.RefObject<HTMLDivElement>;
  top: number | null;
}): JSX.Element {
  const isUser = row.kind === 'user';
  const text = row.kind === 'user' || row.kind === 'assistant' ? row.text : '';
  const timeLabel = messageTimeLabel(row.kind === 'user' ? row.ts : undefined);
  const style: CSSProperties = { position: 'absolute', left: 14, right: 14, top: top ?? MSG_MENU_SAFE_TOP, maxHeight: `calc(100% - ${MSG_MENU_SAFE_TOP + MSG_MENU_SAFE_BOTTOM}px)`, visibility: top == null ? 'hidden' : 'visible', display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 9, WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' };
  return (
    <div ref={groupRef} data-msg-menu-group="true" style={style}>
      <HeldBubbleCopy isUser={isUser} text={text} />
      {timeLabel && <div style={{ flex: 'none', font: `500 10.5px ${MONO}`, color: 'var(--media-overlay-fg)', background: 'var(--media-timestamp-bg)', padding: '3px 8px', borderRadius: 6, letterSpacing: '.02em' }}>{timeLabel}</div>}
      <MessageMenuCard menu={menu} copy={copy} />
    </div>
  );
}

export function MsgActionMenu({ row, menu, copy }: {
  row: ChatRow;
  menu: MMsgMenu;
  copy: MChatEditCopy;
}): JSX.Element {
  const { overlayRef, groupRef, top } = useMsgMenuTop(menu.anchorTop);
  return (
    <div ref={overlayRef} onClick={menu.onClose} style={{ position: 'absolute', inset: 0, zIndex: 8, background: 'var(--overlay-scrim-interaction)', backdropFilter: 'blur(1.5px)', WebkitBackdropFilter: 'blur(1.5px)', overflow: 'hidden' }}>
      <ActionGroup row={row} menu={menu} copy={copy} groupRef={groupRef} top={top} />
    </div>
  );
}

export function EditBar({ title, onCancel }: { title: string; onCancel: () => void }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--proto-alt)', border: '1px solid var(--proto-accent-border)', borderRadius: 11, padding: '8px 8px 8px 12px', marginBottom: 7 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.run, flex: 'none' }} />
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-accent-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
      <div role="button" aria-label="Cancel edit" onClick={onCancel} style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: 8, background: 'var(--proto-card)', border: '1px solid var(--proto-accent-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: MC.run, fontSize: 12, flex: 'none', cursor: 'pointer' }}>×</div>
    </div>
  );
}
