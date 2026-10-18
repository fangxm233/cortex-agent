import {
  createContext, useContext, useEffect, useState,
  type CSSProperties, type ReactNode, Fragment,
} from 'react';
import { useVocab } from '@/i18n';
import type { InlineNode, Block } from '@/lib/markdown';
import { useClipboardFeedback } from '@/design/useClipboardFeedback';
import { inlineText, numericColumns, type MemoryDocBlock } from './memory-doc';

/** Resolves a markdown image `src` to a displayable URL. Async because the bytes behind a Cortex
 *  image need an authenticated fetch — an `<img>` tag cannot carry the `x-cortex-token` header, so
 *  the caller fetches and hands back an object URL, which this view revokes on unmount. */
export type MarkdownImageResolver = (src: string) => Promise<string>;

const ImageResolverContext = createContext<MarkdownImageResolver | null>(null);

/** No resolver in context → the image degrades to its alt text. That is the correct default for
 *  every surface that renders untrusted markdown: nothing is fetched unless a host opts in. */
function InlineImage({ alt, src }: { alt: string; src: string }): JSX.Element {
  const resolve = useContext(ImageResolverContext);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!resolve) return;
    let cancelled = false;
    let created: string | null = null;
    setUrl(null);
    setFailed(false);
    resolve(src)
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        created = objectUrl;
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [resolve, src]);

  if (!resolve || failed || !url) {
    return <span style={{ color: 'var(--proto-muted)' }}>{alt || src}</span>;
  }
  return <img src={url} alt={alt} style={{ maxWidth: '100%', borderRadius: 'var(--r-control)', display: 'block', margin: '8px 0' }} />;
}

// Presentational Markdown renderer for the memory document body. Maps the pure markdown.ts nodes
// onto the reading typography: 14.5/1.75 prose, sentence-weight headings, code in the code face
// only, tables as quiet data. The frontmatter and the title are the document header's job
// (MemoryDocHeader); this renders what follows them.

type BlockOf<T extends Block['type']> = Extract<Block, { type: T }>;

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'bold':
        return (
          <strong key={i} style={{ fontWeight: 650, color: 'var(--proto-ink)' }}>
            {n.text}
          </strong>
        );
      case 'italic':
        return (
          <em key={i} style={{ fontStyle: 'italic' }}>
            {n.text}
          </em>
        );
      case 'code':
        return (
          <code
            key={i}
            style={{ font: '500 .86em var(--font-code)', background: 'var(--proto-line-2)', color: 'var(--proto-ink)', padding: '1px 5px', borderRadius: 4 }}
          >
            {n.text}
          </code>
        );
      case 'link':
        return (
          <a key={i} href={n.href} style={{ color: 'var(--proto-accent)', textDecoration: 'none' }}>
            {n.text}
          </a>
        );
      case 'image':
        return <InlineImage key={i} alt={n.alt} src={n.src} />;
      default:
        return <Fragment key={i}>{n.text}</Fragment>;
    }
  });
}

/** Heading sizes by source level. The document's one `h1` is its title, so a body heading renders
 *  one element level down at most, but keeps the size its own level asks for. */
const HEADING_SIZE: Record<number, CSSProperties> = {
  1: { fontSize: 20, fontWeight: 650, margin: '32px 0 10px' },
  2: { fontSize: 17, fontWeight: 620, margin: '28px 0 8px' },
  3: { fontSize: 15, fontWeight: 620, margin: '22px 0 6px' },
};
const HEADING_DEEP: CSSProperties = { fontSize: 14.5, fontWeight: 600, margin: '18px 0 6px' };

const PROSE: CSSProperties = { fontSize: 14.5, lineHeight: 1.75, color: 'var(--proto-ink-2)', margin: '0 0 10px' };

function HeadingBlock({ block, anchor }: { block: BlockOf<'heading'>; anchor: string | null }): JSX.Element {
  const Tag = `h${Math.min(Math.max(block.level, 2), 6)}` as 'h2';
  return (
    <Tag
      id={anchor ?? undefined}
      style={{
        ...(HEADING_SIZE[block.level] ?? HEADING_DEEP),
        lineHeight: 1.4,
        color: 'var(--proto-ink)',
        // Clears the scroller's top edge when the outline scrolls a heading into view.
        scrollMarginTop: 20,
      }}
    >
      {renderInline(block.inline)}
    </Tag>
  );
}

function ListBlock({ block }: { block: BlockOf<'list'> }): JSX.Element {
  const Tag = block.ordered ? 'ol' : 'ul';
  return (
    // The base stylesheet strips list markers; a document's lists read as lists only with them back.
    <Tag style={{ ...PROSE, paddingLeft: 22, listStyleType: block.ordered ? 'decimal' : 'disc' }}>
      {block.items.map((item, j) => (
        <li key={j} style={{ paddingLeft: 2 }}>{renderInline(item)}</li>
      ))}
    </Tag>
  );
}

/** How far the right edge of a code block fades. The pre carries as much padding on that side, so
 *  the last characters scroll clear of the fade instead of ending under it. */
const CODE_FADE_PX = 44;
const CODE_FADE_MASK = `linear-gradient(to right, #000 calc(100% - ${CODE_FADE_PX}px), transparent)`;

/** Long command lines scroll sideways rather than wrap (a wrapped command is a different command
 *  to copy by eye). The fade is a mask on the scrolling text, not a painted overlay, so it matches
 *  whatever translucent surface the block sits on; the tint and corners belong to the wrapper so the
 *  mask cannot fade them too. The copy button is a sibling, outside the mask. */
function CodeBlock({ block }: { block: BlockOf<'code'> }): JSX.Element {
  const L = useVocab();
  const { copiedKey, copy } = useClipboardFeedback<true>(1500);
  const label = copiedKey === true ? L.wbCopied : L.wbCopy;
  return (
    <div style={{ position: 'relative', margin: '6px 0 14px', background: 'var(--proto-rail)', borderRadius: 'var(--r-control)', overflow: 'hidden' }}>
      <pre
        style={{
          margin: 0,
          padding: `12px ${CODE_FADE_PX + 12}px 12px 14px`,
          font: '400 12.5px/1.7 var(--font-code)',
          color: 'var(--proto-ink-2)',
          whiteSpace: 'pre',
          overflowWrap: 'normal',
          overflowX: 'auto',
          WebkitMaskImage: CODE_FADE_MASK,
          maskImage: CODE_FADE_MASK,
        }}
      >
        <code>{block.text}</code>
      </pre>
      <button
        type="button"
        className="memory-copy"
        data-copied={copiedKey === true || undefined}
        aria-label={label}
        title={label}
        onClick={() => { void copy(block.text, true); }}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          height: 24,
          padding: '0 8px',
          border: 0,
          borderRadius: 6,
          background: 'var(--material-control-bg)',
          boxShadow: '0 0 0 1px var(--proto-line)',
          font: '500 11.5px/24px var(--font-ui)',
          color: copiedKey === true ? 'var(--proto-success)' : 'var(--proto-muted-2)',
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    </div>
  );
}

/** A cell this short — a label, a name, a value — never wraps; only prose-length cells fold. */
const SHORT_CELL_CHARS = 24;

/** A table is data: headers in sentence case and the muted meta weight, numeric columns right-aligned
 *  in tabular figures. Numbers and short cells stay on one line and only prose-length cells wrap, so
 *  a results table does not shred into word stacks; one that still does not fit scrolls sideways in
 *  its own box instead of squeezing every column. */
function TableBlock({ block }: { block: BlockOf<'table'> }): JSX.Element {
  const numeric = numericColumns(block.header, block.rows);
  const cols = numeric.length || 1;
  const cell = (column: number, nodes: InlineNode[] | undefined): CSSProperties => ({
    padding: `0 ${column === cols - 1 ? 0 : 14}px 0 0`,
    textAlign: numeric[column] ? 'right' : 'left',
    whiteSpace: numeric[column] || (nodes && inlineText(nodes).length <= SHORT_CELL_CHARS) ? 'nowrap' : 'normal',
    overflowWrap: 'anywhere',
    verticalAlign: 'top',
  });
  return (
    <div style={{ overflowX: 'auto', margin: '4px 0 14px' }}>
      <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: 13, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' }}>
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, c) => (
              <th
                key={c}
                style={{
                  ...cell(c, undefined),
                  // A long header may fold onto two lines; the column's values decide its width.
                  whiteSpace: 'normal',
                  overflowWrap: 'normal',
                  paddingTop: 7,
                  paddingBottom: 7,
                  fontSize: 12.5,
                  fontWeight: 550,
                  color: 'var(--proto-muted-3)',
                  borderBottom: '1px solid var(--proto-line-4)',
                  verticalAlign: 'bottom',
                }}
              >
                {block.header[c] ? renderInline(block.header[c]) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <td
                  key={c}
                  style={{
                    ...cell(c, row[c]),
                    paddingTop: 8,
                    paddingBottom: 8,
                    color: 'var(--proto-ink-3)',
                    borderBottom: '1px solid var(--proto-line-2)',
                  }}
                >
                  {row[c] ? renderInline(row[c]) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderBlock({ block: b, anchor }: MemoryDocBlock, i: number): ReactNode {
  switch (b.type) {
    case 'heading':
      return <HeadingBlock key={i} block={b} anchor={anchor} />;
    case 'paragraph':
      return (
        <p key={i} style={PROSE}>
          {renderInline(b.inline)}
        </p>
      );
    case 'list':
      return <ListBlock key={i} block={b} />;
    case 'table':
      return <TableBlock key={i} block={b} />;
    case 'code':
      return <CodeBlock key={i} block={b} />;
    case 'blockquote':
      return (
        <blockquote
          key={i}
          style={{ ...PROSE, borderLeft: '2px solid var(--proto-line-3)', padding: '0 0 0 12px', color: 'var(--proto-muted)' }}
        >
          {renderInline(b.inline)}
        </blockquote>
      );
    case 'hr':
      return <div key={i} style={{ height: 1, background: 'var(--proto-line-2)', margin: '20px 0' }} />;
    default:
      return null;
  }
}

export function MarkdownView({ blocks, resolveImage }: {
  blocks: MemoryDocBlock[];
  resolveImage?: MarkdownImageResolver;
}): JSX.Element {
  return (
    <ImageResolverContext.Provider value={resolveImage ?? null}>
      <div>{blocks.map(renderBlock)}</div>
    </ImageResolverContext.Provider>
  );
}
