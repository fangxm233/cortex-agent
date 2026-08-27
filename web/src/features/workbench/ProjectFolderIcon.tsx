// input:  folder open/current/dim state
// output: the rail's project glyph, closed or open
// pos:    Carries a folder's disclosure state without a separate chevron
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// The rail has no disclosure triangle: hierarchy is carried by indent + the guide line, and the
// OPEN/CLOSED state is carried by the glyph itself — closed folder when collapsed, open folder when
// expanded. Colour never encodes identity (that is the project's name); it encodes state only:
// current project fills solid in the accent, an empty project dims, everything else is an outline.

export function ProjectFolderIcon({ open, current, dim, size = 17 }: {
  open: boolean;
  current: boolean;
  dim?: boolean;
  size?: number;
}): JSX.Element {
  const color = current
    ? 'var(--proto-accent)'
    : dim
      ? 'var(--proto-faint)'
      : 'var(--proto-muted-2)';
  const fill = current ? { fill: color } : { stroke: color, strokeWidth: 1.5 };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ flex: 'none', display: 'block' }}
    >
      {open ? (
        <>
          {/* back panel stays an outline in both states — only the front flap carries the fill,
              otherwise a solid open folder reads as an undifferentiated blob at 17px */}
          <path
            d="M1.6 12.2V4.4a1.3 1.3 0 0 1 1.3-1.3h2.7l1.3 1.5h5.5a1.3 1.3 0 0 1 1.3 1.3v1.2"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          <path
            d="M2.9 13h8.8a1.2 1.2 0 0 0 1.13-.79l1.4-3.9A.6.6 0 0 0 13.66 7.5H5.1a1.2 1.2 0 0 0-1.13.79l-1.63 4.5A.5.5 0 0 0 2.9 13z"
            strokeLinejoin="round"
            {...fill}
          />
        </>
      ) : (
        <path
          d="M1.6 4.4A1.3 1.3 0 0 1 2.9 3.1h2.7l1.3 1.5h6.2a1.3 1.3 0 0 1 1.3 1.3v5.8a1.3 1.3 0 0 1-1.3 1.3H2.9a1.3 1.3 0 0 1-1.3-1.3z"
          strokeLinejoin="round"
          {...fill}
        />
      )}
    </svg>
  );
}
