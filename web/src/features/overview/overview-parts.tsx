import type { CSSProperties, ReactNode } from 'react';
import type { ExecMark, OverviewSessionState } from './overview-vm';

// The Overview's small shared pieces: the section heading, the status dot / run mark, and the
// line icons. Sections sit directly on the pane — a 13/600 heading with a muted count and an
// optional link on the right — so the only card on the page is the one the user must act on.

const HEAD: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 };
const TITLE: CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' };
export const META: CSSProperties = { fontSize: 12, color: 'var(--proto-muted-3)', fontVariantNumeric: 'tabular-nums' };
export const LINK: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: 'var(--proto-accent)', cursor: 'pointer', whiteSpace: 'nowrap' };
export const ELLIPSIS: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

export function SectionHead({ title, count, action }: { title: string; count?: number; action?: ReactNode }): JSX.Element {
  return (
    <div style={HEAD}>
      <h2 style={TITLE}>{title}</h2>
      {count != null && <span style={META}>{count}</span>}
      {action != null && <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: 10 }}>{action}</span>}
    </div>
  );
}

/** The leading 16px column every row shares. */
export function IconCell({ children, top }: { children?: ReactNode; top?: boolean }): JSX.Element {
  return (
    <span style={{ width: 16, flex: 'none', display: 'flex', justifyContent: 'center', alignSelf: top ? 'flex-start' : undefined, marginTop: top ? 3 : undefined, color: 'var(--proto-faint)' }}>
      {children}
    </span>
  );
}

/** The rail's dot language: amber = needs you, accent with a breathing ring = running, a still
 *  hollow ring = waiting on a machine. The state word lives in the row's accessible text. */
export function StatusDot({ state }: { state: OverviewSessionState }): JSX.Element {
  const base: CSSProperties = { width: 7, height: 7, borderRadius: '50%', boxSizing: 'border-box', flex: 'none' };
  const look: CSSProperties =
    state === 'you'
      ? { background: 'var(--proto-amber)' }
      : state === 'running'
        ? { background: 'var(--proto-accent)', animation: 'cxring 1.8s ease-out infinite' }
        : { border: '1.5px solid var(--proto-muted-3)' };
  return <span aria-hidden="true" data-overview-dot={state} style={{ ...base, ...look }} />;
}

const svg = (size: number) => ({
  width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
});

export function ChevronLeftIcon(): JSX.Element {
  return <svg {...svg(14)} strokeWidth={1.7}><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>;
}

export function PlusIcon(): JSX.Element {
  return <svg {...svg(13)} strokeWidth={1.7} style={{ color: 'var(--proto-muted)', flex: 'none' }}><path d="M8 3.5v9M3.5 8h9" /></svg>;
}

export function ClockIcon({ size = 13 }: { size?: number }): JSX.Element {
  return <svg {...svg(size)} strokeWidth={1.6}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></svg>;
}

export function FileIcon(): JSX.Element {
  return <svg {...svg(13)} strokeWidth={1.6}><path d="M4 2.5h5l3 3v8H4z" /></svg>;
}

export function IssueIcon(): JSX.Element {
  return <svg {...svg(13)} strokeWidth={1.6}><circle cx="8" cy="8" r="5.5" /><path d="M8 5.2v3.3" /><path d="M8 10.8h.01" /></svg>;
}

/** A decision waiting on the user: an amber diamond, the board decision's own shape. */
export function DecisionIcon(): JSX.Element {
  return <svg {...svg(13)} strokeWidth={1.7} style={{ color: 'var(--proto-amber)' }}><path d="M8 2.5 13.5 8 8 13.5 2.5 8z" /></svg>;
}

/** A recent run's leading mark: check = done, cross = failed, clock = a finished scheduled run,
 *  the running dot while it runs, a dash once cancelled or stale. */
export function RunMark({ mark, label }: { mark: ExecMark; label: string }): JSX.Element {
  let glyph: JSX.Element;
  switch (mark) {
    case 'done':
      glyph = <svg {...svg(13)} strokeWidth={1.9} style={{ color: 'var(--proto-success)' }}><path d="m3.5 8.5 3 3 6-7" /></svg>;
      break;
    case 'failed':
      glyph = <svg {...svg(12)} strokeWidth={2} style={{ color: 'var(--proto-danger)' }}><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>;
      break;
    case 'scheduled':
      glyph = <span style={{ display: 'flex', color: 'var(--proto-muted-3)' }}><ClockIcon size={12} /></span>;
      break;
    case 'running':
      glyph = <StatusDot state="running" />;
      break;
    default:
      glyph = <svg {...svg(12)} strokeWidth={1.8} style={{ color: 'var(--proto-faint)' }}><path d="M4.5 8h7" /></svg>;
  }
  return <span role="img" aria-label={label} title={label} data-run-mark={mark} style={{ display: 'flex' }}>{glyph}</span>;
}
