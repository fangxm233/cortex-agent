// input:  the route's pane children
// output: the single full-window frame: top bar above the pane row
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
        height: '100vh',
        minHeight: 640,
        minWidth: 1280,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--proto-card)',
        overflow: 'hidden',
      }}
    >
      <TopBar />
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}
