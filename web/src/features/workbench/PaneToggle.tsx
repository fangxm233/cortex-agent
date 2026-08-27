// input:  owning pane side, expanded state and the click handler
// output: shared chevron button collapsing or expanding a workbench side pane
// pos:    Collapse control shared by the left rail and the right panel
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export type PaneSide = 'left' | 'right';

// The chevron points at the screen edge the pane collapses INTO, and back toward the centre once
// collapsed — so the arrow always reads as the motion the click produces, mirrored per side.
function chevronPath(pointsLeft: boolean): string {
  return pointsLeft ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6';
}

export function PaneToggle({ side, expanded, label, onClick }: {
  side: PaneSide;
  expanded: boolean;
  label: string;
  onClick: () => void;
}): JSX.Element {
  const pointsLeft = expanded ? side === 'left' : side === 'right';
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        border: '1px solid var(--proto-line)',
        borderRadius: 7,
        background: 'transparent',
        color: 'var(--proto-muted-2)',
        display: 'grid',
        placeItems: 'center',
        padding: 0,
        cursor: 'pointer',
        flex: 'none',
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={chevronPath(pointsLeft)} />
      </svg>
    </button>
  );
}
