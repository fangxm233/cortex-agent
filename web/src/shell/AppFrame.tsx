// input:  the route's pane children
// output: Viewport-filling frame without fixed minimum dimensions
// pos:    Shared frame for every desktop route
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { ReactNode } from 'react';
import { TopBar } from './TopBar';

// Four routes used to repeat this frame verbatim (workbench, overview, memory, skills). It is one
// component now, and the only place that knows the window is a column: top bar, then the panes.
export function AppFrame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        height: '100dvh',
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--proto-card)',
        overflow: 'hidden',
      }}
    >
      <TopBar />
      <div data-app-panes style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}
