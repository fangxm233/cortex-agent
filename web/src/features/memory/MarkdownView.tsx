import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode, type RefObject, Fragment,
} from 'react';
import { useVocab } from '@/i18n';
import type { InlineNode, Block } from '@/lib/markdown';
import { useClipboardFeedback } from '@/design/useClipboardFeedback';
import { edgeFadeMask, inlineText, numericColumns, splitBleed, type MemoryDocBlock } from './memory-doc';

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
    <Tag start={block.start} style={{ ...PROSE, paddingLeft: 22, listStyleType: block.ordered ? 'decimal' : 'disc' }}>
      {block.items.map((item, j) => (
        <li key={j} style={{ paddingLeft: 2 }}>{renderInline(item)}</li>
      ))}
    </Tag>
  );
}

/**
 * Fades a horizontally scrolling box at whichever edge hides content — the trailing edge while
 * there is more to the right, the leading one once something has scrolled out — and drops the fade
 * at the scroll end. A mask on the content rather than a painted overlay, so it matches whatever
 * translucent surface the box sits on. Re-read on scroll, on resize and when `contentKey` changes.
 */
function useEdgeFade(ref: RefObject<HTMLElement>, contentKey: string): { mask: string | undefined; onScroll: () => void } {
  const [edges, setEdges] = useState({ before: false, after: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const before = el.scrollLeft > 1;
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.before === before && prev.after === after ? prev : { before, after }));
  }, [ref]);
  useLayoutEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [ref, update, contentKey]);
  return { mask: edgeFadeMask(edges.before, edges.after), onScroll: update };
}

function maskStyle(mask: string | undefined): CSSProperties {
  return mask ? { WebkitMaskImage: mask, maskImage: mask } : {};
}

/** Long command lines scroll sideways rather than wrap (a wrapped command is a different command
 *  to copy by eye), fading at the edge that hides text. The language and the copy button sit in a
 *  header strip above the code, outside the scrolling area, so they never cover a character and no
 *  faded text peeks out beside them. The tint and corners belong to the wrapper so the mask cannot
 *  fade them too. */
function CodeBlock({ block }: { block: BlockOf<'code'> }): JSX.Element {
  const L = useVocab();
  const { copiedKey, copy } = useClipboardFeedback<true>(1500);
  const preRef = useRef<HTMLPreElement>(null);
  const fade = useEdgeFade(preRef, block.text);
  const label = copiedKey === true ? L.wbCopied : L.wbCopy;
  return (
    <div style={{ margin: '6px 0 14px', background: 'var(--proto-rail)', borderRadius: 'var(--r-control)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, height: 30, padding: '0 6px 0 14px' }}>
        <span style={{ fontSize: 11.5, color: 'var(--proto-muted-3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {block.lang ?? ''}
        </span>
        <button
          type="button"
          className="memory-copy"
          data-copied={copiedKey === true || undefined}
          aria-label={label}
          title={label}
          onClick={() => { void copy(block.text, true); }}
          style={{
            flex: 'none',
            height: 22,
            padding: '0 8px',
            border: 0,
            borderRadius: 6,
            font: '500 11.5px/22px var(--font-ui)',
            color: copiedKey === true ? 'var(--proto-success)' : 'var(--proto-muted-2)',
            cursor: 'pointer',
          }}
        >
          {label}
        </button>
      </div>
      <pre
        ref={preRef}
        onScroll={fade.onScroll}
        style={{
          margin: 0,
          padding: '0 14px 12px',
          font: '400 12.5px/1.7 var(--font-code)',
          color: 'var(--proto-ink-2)',
          whiteSpace: 'pre',
          overflowWrap: 'normal',
          overflowX: 'auto',
          ...maskStyle(fade.mask),
        }}
      >
        <code>{block.text}</code>
      </pre>
    </div>
  );
}

/** Free room beside the reading column that a wide block may reach into, in px (see MemoryView). */
export interface MarkdownBleed {
  left: number;
  right: number;
}

const NO_BLEED: MarkdownBleed = { left: 0, right: 0 };

/** A cell this short — a label, a name, a value — never wraps; only prose-length cells fold. */
const SHORT_CELL_CHARS = 24;

/**
 * Sizes a table's scroll box: as wide as the column for a table that fits it; for one that wants
 * more, out into the free room beside the column (`splitBleed` keeps it centred under the column
 * while both sides have room). Only a table wider than all that room scrolls. The table is first
 * laid out in the whole room so its shrink-to-fit width — prose cells folded, numbers whole — is
 * what gets measured; all of it happens before paint.
 */
function useTableBleed(
  boxRef: RefObject<HTMLDivElement>,
  scrollRef: RefObject<HTMLDivElement>,
  tableRef: RefObject<HTMLTableElement>,
  bleed: MarkdownBleed,
  contentKey: string,
): void {
  useLayoutEffect(() => {
    const box = boxRef.current;
    const scroller = scrollRef.current;
    const table = tableRef.current;
    if (!box || !scroller || !table) return undefined;
    const fit = (): void => {
      const column = box.clientWidth;
      scroller.style.marginLeft = `${-bleed.left}px`;
      scroller.style.width = `${column + bleed.left + bleed.right}px`;
      table.style.minWidth = '0';
      const wants = table.offsetWidth;
      table.style.minWidth = '100%';
      const reach = splitBleed(wants - column, bleed.left, bleed.right);
      scroller.style.marginLeft = reach.left ? `${-reach.left}px` : '';
      scroller.style.width = reach.left || reach.right ? `${column + reach.left + reach.right}px` : '';
    };
    fit();
    let live = true;
    void document.fonts?.ready.then(() => { if (live) fit(); });
    let width = box.clientWidth;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      fit();
    });
    observer?.observe(box);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [boxRef, scrollRef, tableRef, bleed.left, bleed.right, contentKey]);
}

/** A table is data: headers in sentence case and the muted meta weight, numeric columns right-aligned
 *  in tabular figures. Numbers and short cells stay on one line and only prose-length cells wrap, so
 *  a results table does not shred into word stacks. A table wider than the column reaches out into
 *  the free room beside it; one wider than that scrolls sideways — headers with their columns —
 *  under an edge fade that says there is more. */
function TableBlock({ block, bleed }: { block: BlockOf<'table'>; bleed: MarkdownBleed }): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const contentKey = JSON.stringify(block);
  useTableBleed(boxRef, scrollRef, tableRef, bleed, contentKey);
  const fade = useEdgeFade(scrollRef, contentKey);
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
    <div ref={boxRef} style={{ margin: '4px 0 14px' }}>
      <div ref={scrollRef} onScroll={fade.onScroll} style={{ overflowX: 'auto', ...maskStyle(fade.mask) }}>
        <table ref={tableRef} style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: 13, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' }}>
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
    </div>
  );
}

function renderBlock({ block: b, anchor }: MemoryDocBlock, i: number, bleed: MarkdownBleed): ReactNode {
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
      return <TableBlock key={i} block={b} bleed={bleed} />;
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

export function MarkdownView({ blocks, resolveImage, bleed = NO_BLEED }: {
  blocks: MemoryDocBlock[];
  resolveImage?: MarkdownImageResolver;
  /** Room beside the reading column that wide tables may use; none by default. */
  bleed?: MarkdownBleed;
}): JSX.Element {
  return (
    <ImageResolverContext.Provider value={resolveImage ?? null}>
      <div>{blocks.map((block, i) => renderBlock(block, i, bleed))}</div>
    </ImageResolverContext.Provider>
  );
}
