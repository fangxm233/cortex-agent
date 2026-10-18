import { useVocab } from '@/i18n';
import type { MemoryOutlineEntry } from './memory-doc';

// "On this page": the document's own headings as a sticky side column. The current section carries
// an ink marker on the hairline track; a click scrolls its heading into view. memory-view.css hides
// the column when the pane is too narrow to hold it beside a readable text column.

export function MemoryOutline({ entries, activeId, onJump }: {
  entries: MemoryOutlineEntry[];
  activeId: string | null;
  onJump: (id: string) => void;
}): JSX.Element {
  const L = useVocab();
  return (
    <nav
      className="memory-side"
      aria-label={L.memOnThisPage}
      style={{ flex: '0 0 180px', minWidth: 0, position: 'sticky', top: 32, alignSelf: 'flex-start', paddingTop: 4 }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-muted-2)', marginBottom: 8 }}>{L.memOnThisPage}</div>
      <div style={{ display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--proto-line)' }}>
        {entries.map((entry) => {
          const active = entry.id === activeId;
          return (
            <button
              key={entry.id}
              type="button"
              className="memory-outline-link"
              aria-current={active ? 'location' : undefined}
              onClick={() => onJump(entry.id)}
              style={{
                textAlign: 'left',
                border: 0,
                borderRadius: 0,
                background: 'transparent',
                // The marker is an inset edge laid over the track (hence the -1px), not a border, so
                // it costs no width and the labels never shift when the current section moves.
                boxShadow: active ? 'inset 1.5px 0 0 var(--proto-ink)' : 'none',
                marginLeft: -1,
                padding: `4px 0 4px ${12 + entry.depth * 10}px`,
                fontSize: 12.5,
                lineHeight: 1.4,
                fontWeight: active ? 550 : 400,
                color: active ? 'var(--proto-ink)' : 'var(--proto-muted-3)',
                cursor: 'pointer',
                overflowWrap: 'anywhere',
              }}
            >
              {entry.text}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
