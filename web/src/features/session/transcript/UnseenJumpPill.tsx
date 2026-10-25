import type { CSSProperties } from 'react';
import { fmt, useVocabOptional } from '@/i18n';
import type { UnseenJumpTarget } from './useUnseenJump';

/** Centred over the bottom of the stream; `bottom` comes from the surface. */
const PILL: CSSProperties = {
  position: 'absolute', left: '50%', zIndex: 3,
  display: 'inline-flex', alignItems: 'center', gap: 6,
  height: 28, padding: '0 12px', borderRadius: 'var(--r-pill)',
  border: '1px solid var(--proto-line-2)',
  background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)',
  color: 'var(--proto-ink-2)', fontSize: 12, fontWeight: 550, whiteSpace: 'nowrap', cursor: 'pointer',
  animation: 'cxtoast .22s cubic-bezier(.22,1,.36,1) both',
};

const TOUCH: CSSProperties = { height: 34, padding: '0 14px', fontSize: 13 };

function Arrow({ up }: { up: boolean }): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ color: 'var(--proto-accent)', flex: 'none' }}>
      <path d={up ? 'M6 10V2M2.5 5.5 6 2l3.5 3.5' : 'M6 2v8M2.5 6.5 6 10l3.5-3.5'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The way to the earliest reply the reader has not seen yet (see useUnseenJump). */
export function UnseenJumpPill({ target, onJump, bottom, touch = false }: {
  target: UnseenJumpTarget | null;
  onJump: () => void;
  bottom: string | number;
  touch?: boolean;
}): JSX.Element | null {
  const L = useVocabOptional();
  if (!target) return null;
  const label = target.count === 1 ? L.chatUnseenOne : fmt(L.chatUnseenMany, { n: target.count });
  return (
    <button type="button" data-unseen-jump={target.above ? 'up' : 'down'} onClick={onJump}
      style={{ ...PILL, ...(touch ? TOUCH : null), bottom }}>
      <Arrow up={target.above} />
      {label}
    </button>
  );
}
