import type { CSSProperties, ReactNode } from 'react';

// input:  glass tokens from public/theme.css
// output: the floating-pane chrome every top-level panel shares
// pos:    the single definition of "this is a pane", used by the rail and the workspace

/**
 * The chrome of a top-level floating pane: a translucent sheet on the mesh ground, lifted off it by
 * a shadow and separated from it by a hairline ring rather than a border.
 *
 * NOTE THE ABSENCE OF `backdrop-filter`, which is deliberate and load-bearing.
 *
 * A pane sits on nothing but `--app-backdrop`, a smooth radial gradient. Blurring a smooth gradient
 * is visually a no-op — there is no detail to destroy — so the filter would buy exactly zero pixels
 * of appearance. It would also cost the most of any blur in the app, because these are the two
 * largest surfaces on screen.
 *
 * Worse, it would break the blur that DOES matter. An element with `backdrop-filter` becomes a
 * backdrop root, and a descendant's own `backdrop-filter` then has nothing real left to sample: the
 * context drawer nested inside this pane rendered with its backdrop merely *faded* rather than
 * blurred, so the chat text behind it stayed sharp and legible straight through the sheet. Keeping
 * the panes filter-free is what lets the drawer, the modals and the command palette actually blur.
 *
 * So: translucency here, blur only on the overlays that float over real content.
 */
export const glassPanelStyle: CSSProperties = {
  borderRadius: 'var(--r-panel)',
  background: 'var(--glass-1)',
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
