// input:  Mobile composer value, actions, toolbar slots, and fullscreen controls
// output: Inline and fullscreen mobile composer presentation with text metrics
// pos:    Shared mobile composer presentation primitives
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { PlusGlyph } from '@/design';
import { MC, MONO } from './mobile-theme';

export function composerLineCount(value: string): number {
  return value === '' ? 1 : value.split('\n').length;
}

export function composerCharCount(value: string): number {
  return [...value].length;
}

export function composerCountLabel(value: string, lineUnit: string, charUnit: string): string {
  return `${composerLineCount(value)} ${lineUnit} · ${composerCharCount(value)} ${charUnit}`;
}

const COMPOSER_LINE_H = 20;
const COMPOSER_PAD_V = 12;
const COMPOSER_MIN_H = 46;
const COMPOSER_MAX_H = 5 * COMPOSER_LINE_H + 2 * COMPOSER_PAD_V;

function ExpandIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke={MC.muted} strokeWidth="1.5">
      <path d="M6 1h3v3M4 9H1V6M9 1 5.8 4.2M1 9l3.2-3.2" />
    </svg>
  );
}

function CollapseIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke={MC.muted} strokeWidth="1.5">
      <path d="M9 1 5.8 4.2m0 0H8.6M5.8 4.2V1.4M1 9l3.2-3.2m0 0H1.4m2.8 0v2.8" />
    </svg>
  );
}

function SendGlyph({ size = 16, color = 'var(--ink-solid-fg)' }: { size?: number; color?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.8">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

const circleKeyBase: CSSProperties = {
  flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
  boxSizing: 'border-box',
};

function SecondarySendKey({ enabled, onSend, size = 36 }: {
  enabled: boolean;
  onSend?: () => void;
  size?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Send"
      disabled={!enabled}
      onClick={onSend}
      style={{ ...circleKeyBase, width: size, height: size, background: MC.card, border: `1.5px solid ${enabled ? MC.ink : 'var(--proto-line-3)'}`, opacity: enabled ? 1 : 0.45, cursor: enabled ? 'pointer' : 'default' }}
    >
      <SendGlyph size={14} color={MC.ink} />
    </button>
  );
}

function PrimaryKey({ running, enabled, onSend, onStop, size = 36 }: {
  running: boolean;
  enabled: boolean;
  onSend?: () => void;
  onStop?: () => void;
  size?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={running ? 'Stop' : 'Send'}
      disabled={!enabled}
      onClick={running ? onStop : onSend}
      style={{ ...circleKeyBase, width: size, height: size, background: MC.inkSolid, border: 'none', opacity: enabled ? 1 : 0.45, cursor: enabled ? 'pointer' : 'default' }}
    >
      {running ? <span style={{ width: 12, height: 12, background: MC.inkSolidFg, borderRadius: 3 }} /> : <SendGlyph size={15} />}
    </button>
  );
}

function useAutosize(
  ref: React.RefObject<HTMLTextAreaElement>,
  value: string | undefined,
  onMultiline: (multiline: boolean) => void,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const full = el.scrollHeight;
    el.style.height = `${Math.min(full, COMPOSER_MAX_H)}px`;
    el.style.overflowY = full > COMPOSER_MAX_H ? 'auto' : 'hidden';
    onMultiline(full > COMPOSER_MIN_H + 2);
  }, [ref, value, onMultiline]);
}

export interface MComposerProps {
  placeholder: string;
  above?: ReactNode;
  commandMenu?: ReactNode;
  leading?: ReactNode;
  tools?: ReactNode;
  sendEnabled?: boolean;
  value?: string;
  onChange?: (value: string) => void;
  onSend?: () => void;
  running?: boolean;
  onStop?: () => void;
  stopEnabled?: boolean;
  lineUnit?: string;
  charUnit?: string;
  onPlus?: () => void;
  tone?: 'default' | 'amber' | 'accent';
}

type ComposerCardProps = MComposerProps & {
  focused: boolean;
  showExpand: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  onFocus: (focused: boolean) => void;
  onExpand: () => void;
};

function composerCardStyle(tone: MComposerProps['tone'], focused: boolean): CSSProperties {
  return {
    border: `1.5px solid ${tone === 'amber' ? MC.amber : tone === 'accent' || focused ? MC.run : 'var(--proto-line-3)'}`,
    borderRadius: 18, background: MC.card,
    boxShadow: tone === 'amber' ? 'var(--focus-ring-amber)' : tone === 'accent' || focused ? 'var(--focus-ring-accent)' : undefined,
    boxSizing: 'border-box', padding: '2px 10px 8px 12px',
  };
}

function ComposerField(props: ComposerCardProps): JSX.Element {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', padding: `0 ${props.showExpand ? 28 : 2}px 0 2px` }}>
      <textarea
        ref={props.textareaRef}
        rows={1}
        value={props.value}
        onChange={(event) => props.onChange?.(event.target.value)}
        onFocus={() => props.onFocus(true)}
        onBlur={() => props.onFocus(false)}
        placeholder={props.placeholder}
        style={{ flex: 1, minWidth: 0, resize: 'none', border: 'none', outline: 'none', background: 'transparent', padding: `${COMPOSER_PAD_V}px 0 6px`, margin: 0, maxHeight: COMPOSER_MAX_H, fontSize: 13.5, lineHeight: `${COMPOSER_LINE_H}px`, color: MC.ink, fontFamily: 'inherit', boxSizing: 'border-box' }}
      />
      {props.showExpand && <ExpandButton onClick={props.onExpand} />}
    </div>
  );
}

function ExpandButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Expand"
      onClick={onClick}
      style={{ position: 'absolute', top: 8, right: 0, width: 22, height: 22, borderRadius: '50%', background: 'var(--m-gray)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
    >
      <ExpandIcon />
    </button>
  );
}

function ComposerToolbar(props: MComposerProps): JSX.Element {
  const running = props.running ?? false;
  return (
    <div data-composer-toolbar style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {props.leading}
      <span style={{ marginLeft: 'auto' }} />
      {props.tools}
      {running && <SecondarySendKey enabled={props.sendEnabled ?? true} onSend={props.onSend} />}
      <PrimaryKey running={running} enabled={running ? props.stopEnabled ?? true : props.sendEnabled ?? true} onSend={props.onSend} onStop={props.onStop} />
    </div>
  );
}

function ComposerCard(props: ComposerCardProps): JSX.Element {
  return (
    <div data-composer-card style={composerCardStyle(props.tone, props.focused)}>
      <ComposerField {...props} />
      <ComposerToolbar {...props} />
    </div>
  );
}

export function MComposer(props: MComposerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [multiline, setMultiline] = useState(() => composerLineCount(props.value ?? '') > 1);
  useAutosize(textareaRef, props.value, setMultiline);
  const fullscreen = expanded ? <ComposerFullscreen {...props} value={props.value ?? ''} onCollapse={() => setExpanded(false)} onSend={() => { props.onSend?.(); setExpanded(false); }} onCommandPick={() => setExpanded(false)} /> : null;
  return (
    <div style={{ flex: 'none', padding: '6px 14px 34px', paddingBottom: 'calc(14px + env(safe-area-inset-bottom))', background: MC.canvas }}>
      {props.above}
      {!expanded ? props.commandMenu : null}
      <ComposerCard {...props} focused={focused} showExpand={multiline && !expanded} textareaRef={textareaRef} onFocus={setFocused} onExpand={() => setExpanded(true)} />
      {fullscreen}
    </div>
  );
}

export interface ComposerFullscreenProps {
  value: string;
  placeholder: string;
  onChange?: (value: string) => void;
  onSend?: () => void;
  sendEnabled?: boolean;
  running?: boolean;
  onStop?: () => void;
  stopEnabled?: boolean;
  onCollapse: () => void;
  onPlus?: () => void;
  commandMenu?: ReactNode;
  onCommandPick?: () => void;
  onSlash?: () => void;
  lineUnit?: string;
  charUnit?: string;
}

const fullscreenShellStyle: CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 4, background: MC.canvas, padding: '8px 10px',
  paddingBottom: 'calc(8px + env(safe-area-inset-bottom))', boxSizing: 'border-box', display: 'flex',
};
const fullscreenCardStyle: CSSProperties = {
  flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden',
  border: `1.5px solid ${MC.run}`, borderRadius: 18, background: MC.card,
  boxShadow: 'var(--focus-ring-accent), var(--shadow-panel)', boxSizing: 'border-box',
};
const fullscreenTextareaStyle: CSSProperties = {
  flex: 1, minHeight: 0, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
  padding: '14px 40px 8px 16px', margin: 0, fontSize: 14.5, lineHeight: '22px', color: MC.ink,
  fontFamily: 'inherit', boxSizing: 'border-box',
};
const fullscreenToolStyle: CSSProperties = {
  flex: 'none', width: 30, height: 30, borderRadius: '50%', border: `1px solid ${MC.hairline}`,
  background: MC.card, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MC.muted,
  cursor: 'pointer',
};

function FullscreenField({ props, textareaRef }: {
  props: ComposerFullscreenProps;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}): JSX.Element {
  return (
    <>
      <textarea ref={textareaRef} value={props.value} onChange={(event) => props.onChange?.(event.target.value)} placeholder={props.placeholder} style={fullscreenTextareaStyle} />
      <button type="button" aria-label="Collapse" onClick={props.onCollapse} style={{ position: 'absolute', top: 11, right: 11, width: 26, height: 26, borderRadius: '50%', background: 'var(--m-gray)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
        <CollapseIcon />
      </button>
    </>
  );
}

function FullscreenTools({ props, insertSlash }: {
  props: ComposerFullscreenProps;
  insertSlash: () => void;
}): JSX.Element {
  const running = props.running ?? false;
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 8px 14px', borderTop: `1px solid ${MC.divider}` }}>
      <button type="button" aria-label="Attach" onClick={props.onPlus} style={fullscreenToolStyle}><PlusGlyph /></button>
      <button type="button" aria-label="Slash command" onClick={insertSlash} style={{ ...fullscreenToolStyle, font: `600 13px ${MONO}` }}>/</button>
      <span style={{ marginLeft: 'auto', flex: 'none', whiteSpace: 'nowrap', font: `400 10px ${MONO}`, color: MC.faint }}>
        {composerCountLabel(props.value, props.lineUnit ?? '行', props.charUnit ?? '字')}
      </span>
      {running && <SecondarySendKey enabled={props.sendEnabled ?? true} onSend={props.onSend} size={34} />}
      <PrimaryKey running={running} enabled={running ? props.stopEnabled ?? true : props.sendEnabled ?? true} onSend={props.onSend} onStop={props.onStop} size={38} />
    </div>
  );
}

function useFullscreenFocus(ref: React.RefObject<HTMLTextAreaElement>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [ref]);
}

export function ComposerFullscreen(props: ComposerFullscreenProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useFullscreenFocus(textareaRef);
  const insertSlash = props.onSlash ?? (() => props.onChange?.(props.value ? `${props.value}/` : '/'));
  return (
    <div style={fullscreenShellStyle}>
      <div style={fullscreenCardStyle}>
        <FullscreenField props={props} textareaRef={textareaRef} />
        {props.commandMenu ? <div data-fullscreen-command-menu onClick={props.onCommandPick}>{props.commandMenu}</div> : null}
        <FullscreenTools props={props} insertSlash={insertSlash} />
      </div>
    </div>
  );
}
