import { Component, useEffect, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { useVocabOptional } from '@/i18n';
import { reportRenderError } from './crash-capture';
import { loadTiming } from './load-perf';

// Wraps the whole app, above every provider, so the fallback may render with no theme or
// language context: it reads the cached language and falls back to system colours.

const FRAME: CSSProperties = {
  minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, boxSizing: 'border-box',
  background: 'var(--proto-bg, Canvas)', color: 'var(--proto-ink, CanvasText)',
  fontFamily: 'inherit',
};
const TITLE: CSSProperties = { fontSize: 15, fontWeight: 600, margin: 0 };
const BODY: CSSProperties = { fontSize: 13, margin: '6px 0 14px', color: 'var(--proto-muted, GrayText)' };
const BUTTON: CSSProperties = {
  font: 'inherit', fontSize: 13, padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
  border: '1px solid var(--proto-line-2, ButtonBorder)', background: 'var(--proto-card, ButtonFace)',
  color: 'inherit',
};

export function CrashFallback({ onReload = () => window.location.reload() }: { onReload?: () => void }) {
  const L = useVocabOptional();
  return (
    <div role="alert" data-crash-fallback style={FRAME}>
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <p style={TITLE}>{L.tmCrashTitle}</p>
        <p style={BODY}>{L.tmCrashBody}</p>
        <button type="button" style={BUTTON} onClick={onReload}>{L.tmCrashReload}</button>
      </div>
    </div>
  );
}

/** Records the root's first commit for the load report. */
function FirstCommit({ children }: { children: ReactNode }) {
  useEffect(() => loadTiming.markFirstRender(), []);
  return <>{children}</>;
}

interface BoundaryState { failed: boolean }

export class RootErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRenderError(error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) return <CrashFallback />;
    return <FirstCommit>{this.props.children}</FirstCommit>;
  }
}
