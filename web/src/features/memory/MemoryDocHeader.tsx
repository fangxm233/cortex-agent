import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { useVocab } from '@/i18n';
import type { MemoryDoc, MemoryStatusTone } from './memory-doc';
import { kindLabel, statusLabel, type LineDiffLabel } from './memory-vm';

// The head of a memory document in Read mode: what the frontmatter used to show as a mono key/value
// card, read as a document instead — a property line, the title, the summary as its lede, and one
// line saying when the file last changed. Keys the line does not use stay in a quiet disclosure.

const STATUS_DOT: Record<MemoryStatusTone, string> = {
  success: 'var(--proto-success)',
  amber: 'var(--proto-amber)',
  danger: 'var(--proto-danger)',
  muted: 'var(--proto-faint)',
};
const STATUS_TEXT: Record<MemoryStatusTone, string> = {
  success: 'var(--proto-success)',
  amber: 'var(--proto-amber-fg)',
  danger: 'var(--proto-danger)',
  muted: 'var(--proto-muted)',
};

const META: CSSProperties = { fontSize: 12.5, color: 'var(--proto-muted)', fontVariantNumeric: 'tabular-nums' };

export function ClockGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </svg>
  );
}

/** `+3 −1` in the success / danger inks, or the words for a file identical to HEAD. */
export function LineDiffText({ diff }: { diff: LineDiffLabel }): JSX.Element {
  const L = useVocab();
  if (diff.clean) return <span>{L.memNoLineChanges}</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 5, fontWeight: 550 }}>
      <span style={{ color: 'var(--proto-success)' }}>{diff.added}</span>
      <span style={{ color: 'var(--proto-danger)' }}>{diff.removed}</span>
    </span>
  );
}

function PropertyLine({ doc }: { doc: MemoryDoc }): JSX.Element | null {
  const L = useVocab();
  const kind = kindLabel(doc, L);
  const items: ReactNode[] = [];
  if (kind) items.push(<span key="kind">{kind}</span>);
  if (doc.date) items.push(<span key="date">{doc.date}</span>);
  if (doc.status) {
    const { tone } = doc.status;
    items.push(
      <span key="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: STATUS_TEXT[tone], fontWeight: 550 }}>
        <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_DOT[tone], flex: 'none' }} />
        {statusLabel(doc.status, L)}
      </span>,
    );
  }
  if (items.length === 0 && doc.tags.length === 0) return null;
  return (
    <div style={{ ...META, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 22 }}>
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true">·</span>}
          {item}
        </Fragment>
      ))}
      {doc.tags.length > 0 && (
        <span style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
          {doc.tags.map((tag) => (
            <span
              key={tag}
              style={{
                height: 22,
                padding: '0 8px',
                borderRadius: 'var(--r-pill)',
                background: 'var(--proto-line-2)',
                display: 'inline-flex',
                alignItems: 'center',
                fontSize: 12,
                color: 'var(--proto-muted-2)',
              }}
            >
              {tag}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function PropertiesDisclosure({ doc }: { doc: MemoryDoc }): JSX.Element | null {
  const L = useVocab();
  if (doc.properties.length === 0) return null;
  return (
    <details className="memory-props" style={{ margin: '0 0 6px' }}>
      <summary
        style={{ ...META, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', borderRadius: 6, padding: '2px 0' }}
      >
        <svg className="memory-props-chevron" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transition: 'transform .12s' }}>
          <path d="m6 4 4 4-4 4" />
        </svg>
        {L.memProperties}
        <span style={{ color: 'var(--proto-muted-3)' }}>{doc.properties.length}</span>
      </summary>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content minmax(0, 1fr)',
          columnGap: 16,
          rowGap: 4,
          margin: '6px 0 4px 16px',
          fontSize: 12.5,
          lineHeight: 1.6,
        }}
      >
        {doc.properties.map((prop, i) => (
          <Fragment key={`${prop.key}:${i}`}>
            <dt style={{ color: 'var(--proto-muted)' }}>{prop.key}</dt>
            <dd
              style={{
                margin: 0,
                minWidth: 0,
                overflowWrap: 'anywhere',
                color: 'var(--proto-ink-3)',
                font: prop.code ? '400 12px/1.7 var(--font-code)' : undefined,
              }}
            >
              {prop.value}
            </dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}

export function MemoryDocHeader({ doc, updated, lineDiff, onShowChanges }: {
  doc: MemoryDoc;
  /** "Updated 16m ago" from the file's real mtime. */
  updated: string;
  /** Working copy vs HEAD; null when git cannot say (the note then omits it). */
  lineDiff: LineDiffLabel | null;
  /** Switches to Changes mode; omitted when the document is already shown there. */
  onShowChanges?: () => void;
}): JSX.Element {
  const L = useVocab();
  return (
    <header style={{ marginBottom: 6 }}>
      <PropertyLine doc={doc} />
      {doc.title && (
        <h1 style={{ fontSize: 24, lineHeight: 1.3, fontWeight: 650, letterSpacing: '-0.01em', color: 'var(--proto-ink)', margin: '12px 0 10px' }}>
          {doc.title}
        </h1>
      )}
      {doc.summary && (
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--proto-ink-3)', margin: 0 }}>{doc.summary}</p>
      )}
      {/* Who made the change is not recorded with the file, so the note says when and how much —
          never a fabricated author. The link opens the per-line history (Changes). */}
      <div style={{ ...META, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '14px 0 6px', color: 'var(--proto-muted-3)' }}>
        <ClockGlyph />
        <span>{updated}</span>
        {lineDiff && (
          <>
            <span aria-hidden="true">·</span>
            <LineDiffText diff={lineDiff} />
          </>
        )}
        {onShowChanges && (
          <button
            type="button"
            className="content-text-action"
            onClick={onShowChanges}
            style={{ color: 'var(--proto-accent)', fontWeight: 500, cursor: 'pointer', marginLeft: 2 }}
          >
            {L.memViewChanges}
          </button>
        )}
      </div>
      <PropertiesDisclosure doc={doc} />
    </header>
  );
}
