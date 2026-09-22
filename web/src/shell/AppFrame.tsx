import type { ReactNode } from 'react';
import { TopBar } from './TopBar';

// Four routes used to repeat this frame verbatim (workbench, overview, memory, skills). It is one
// component now, and the only place that knows the window is a column: top bar, then the panes.
//
// The window itself is the mesh ground; the panes float on it inside a gutter. The gutter is on the
// PANE ROW, not on the whole column, so the top bar still spans the full width — it carries the
// Tauri drag region and, on Windows/Linux, the caption buttons, which have to reach the window's
// corner to read as real window chrome rather than as app content.
export function AppFrame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        height: '100dvh',
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--app-backdrop)',
        overflow: 'hidden',
      }}
    >
      <TopBar />
      <div
        data-app-panes
        style={{
          flex: 1,
          display: 'flex',
          gap: 'var(--app-gutter)',
          minHeight: 0,
          padding: '0 var(--app-gutter) var(--app-gutter)',
          boxSizing: 'border-box',
        }}
      >
        {children}
      </div>
    </div>
  );
}
