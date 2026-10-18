import { useVocab } from '@/i18n';
import type { TreeRow } from './memory-vm';

// The file column: one 28px row grammar — a 14px icon column, the name in the UI face, and a
// right-aligned meta slot holding a directory's plain count or a file's recent-change dot.
// Selection is a gray tint with ink text; hover tints come from memory-view.css.

const RECENT_DOT = { width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-accent)', flex: 'none' } as const;

function FileGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M4 2.5h5l3 3v8H4z" />
    </svg>
  );
}

function ChevronGlyph({ open }: { open: boolean }): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ transform: open ? undefined : 'rotate(-90deg)', transition: 'transform .12s' }}>
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function TreeRowView({ row, onPick, onToggle }: {
  row: TreeRow;
  onPick: (path: string) => void;
  onToggle: (dir: string) => void;
}): JSX.Element {
  const L = useVocab();
  const isDir = row.kind === 'dir';
  const activate = isDir ? () => onToggle(row.name) : row.path ? () => onPick(row.path!) : undefined;
  return (
    <div
      className="memory-tree-row"
      role={activate ? 'button' : undefined}
      tabIndex={activate ? 0 : undefined}
      aria-expanded={isDir ? row.expanded ?? undefined : undefined}
      aria-current={row.selected ? 'true' : undefined}
      onKeyDown={(event) => {
        if (activate && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault(); activate();
        }
      }}
      onClick={activate}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 28,
        flex: 'none',
        padding: `0 8px 0 ${row.depth === 1 ? 30 : 8}px`,
        marginTop: isDir ? 6 : 0,
        background: row.selected ? 'var(--proto-gray)' : undefined,
        borderRadius: 7,
        cursor: activate ? 'pointer' : 'default',
        fontSize: 13,
        fontWeight: row.selected || isDir ? 550 : 400,
        color: row.selected || isDir ? 'var(--proto-ink)' : 'var(--proto-ink-3)',
      }}
    >
      {row.depth === 0 && (
        <span style={{ width: 14, flex: 'none', display: 'flex', justifyContent: 'center', color: 'var(--proto-muted-3)' }}>
          {isDir ? <ChevronGlyph open={row.expanded !== false} /> : <FileGlyph />}
        </span>
      )}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
      {row.right != null && (
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 400, color: 'var(--proto-muted-3)', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>
          {row.right}
        </span>
      )}
      {row.recent && (
        <span role="img" aria-label={L.memRecentChange} title={L.memRecentChange} style={{ ...RECENT_DOT, marginLeft: 'auto' }} />
      )}
    </div>
  );
}

export function MemoryTree({ rows, loading, showLegend, onPick, onToggle }: {
  rows: TreeRow[];
  loading: boolean;
  /** Some file carries the recent-change dot, so the column says what the dot means. */
  showLegend: boolean;
  onPick: (path: string) => void;
  onToggle: (dir: string) => void;
}): JSX.Element {
  const L = useVocab();
  const note = { fontSize: 12, color: 'var(--proto-muted-3)', padding: '6px 8px' } as const;
  return (
    <nav
      aria-label={L.memFiles}
      style={{
        width: 'clamp(168px, 26%, 214px)',
        flex: 'none',
        boxSizing: 'border-box',
        borderRight: '1px solid var(--proto-line-2)',
        padding: '12px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        overflow: 'auto',
        scrollbarGutter: 'stable',
      }}
    >
      {loading && <div style={note}>{L.memLoading}</div>}
      {!loading && rows.length === 0 && <div style={note}>{L.memNoFiles}</div>}
      {rows.map((r) => (
        <TreeRowView key={r.path ?? `dir:${r.name}`} row={r} onPick={onPick} onToggle={onToggle} />
      ))}
      {showLegend && (
        <div style={{ ...note, marginTop: 'auto', paddingTop: 12, display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.5 }}>
          <span aria-hidden="true" style={{ ...RECENT_DOT, marginTop: 6 }} />
          {L.memRecentChange}
        </div>
      )}
    </nav>
  );
}
