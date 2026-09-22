import type { CSSProperties, ReactNode } from 'react';

// input:  glass tokens from public/theme.css
// output: the floating-pane chrome every top-level panel shares
// pos:    the single definition of "this is a pane", used by the rail and the workspace

/**
 * The chrome of a top-level floating pane: a translucent sheet that blurs the mesh ground, lifted
 * off it by a shadow and separated from it by a hairline ring rather than a border.
 *
 * This is the ONLY place `backdrop-filter` belongs. Blur is a per-pixel read of everything behind
 * the element, so its cost scales with area AND with how often the area is repainted — a blurred
 * pane that contains a scrolling list is cheap (the pane does not move), while blurring the rows
 * themselves would re-read the backdrop on every scroll frame. Surfaces drawn *inside* a pane use
 * `--glass-2`, which is translucent but unblurred: it composites over the blur its parent already
 * produced, so it looks like glass-on-glass and costs a plain alpha blend.
 */
export const glassPanelStyle: CSSProperties = {
  borderRadius: 'var(--r-panel)',
  background: 'var(--glass-1)',
  backdropFilter: 'var(--glass-filter)',
  WebkitBackdropFilter: 'var(--glass-filter)',
  boxShadow: 'var(--shadow-panel-float), 0 0 0 1px var(--proto-line)',
  overflow: 'hidden',
};

/**
 * The right-hand pane of every route: chat/overview/memory/skills plus the context panel and the
 * dock, all inside ONE sheet. They share a pane rather than floating separately because they are
 * one workspace — the context panel is a drawer *over* the content, not a neighbour of it.
 */
export function WorkspacePanel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      data-workspace-panel
      style={{
        ...glassPanelStyle,
        flex: '1 1 0',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        position: 'relative',
      }}
    >
      {children}
    </div>
  );
}
