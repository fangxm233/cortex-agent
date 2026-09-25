// input:  Markdown blocks, inline nodes, KaTeX, clipboard feedback
// output: ChatMarkdown
// pos:    Transcript prose, opaque code blocks with a hover copy button, and wide tables
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useVocabOptional } from '@/i18n';
import { parseBlocks, type Block, type InlineNode } from '@/lib/markdown';
import { useClipboardFeedback } from './useClipboardFeedback';

const mono = "'IBM Plex Mono',monospace";
type InlineRenderer = (node: InlineNode, key: number) => ReactNode;
/** Each renderer receives its OWN narrowed variant, so adding an inline node type is a compile
 *  error here until it is handled rather than a silent `node.text` crash at runtime. */
type InlineRenderers = {
  [K in InlineNode['type']]: (node: Extract<InlineNode, { type: K }>, key: number) => ReactNode;
};

function MathMarkup({ text, display }: { text: string; display: boolean }): JSX.Element {
  const markup = katex.renderToString(text, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    maxExpand: 1000,
    maxSize: 50,
  });
  const style: CSSProperties = display
    ? { overflowX: 'auto', overflowY: 'hidden', maxWidth: '100%' }
    : { display: 'inline-block', maxWidth: '100%', overflowX: 'auto', overflowY: 'hidden', verticalAlign: 'bottom' };
  const Tag = display ? 'div' : 'span';
  return <Tag style={style} dangerouslySetInnerHTML={{ __html: markup }} />;
}

const INLINE_RENDERERS: InlineRenderers = {
  text: (node, key) => <Fragment key={key}>{node.text}</Fragment>,
  bold: (node, key) => <strong key={key} style={{ fontWeight: 650 }}>{node.text}</strong>,
  italic: (node, key) => <em key={key}>{node.text}</em>,
  code: (node, key) => (
    <code key={key} style={{ font: `500 12.5px ${mono}`, background: 'var(--proto-gray)', borderRadius: 'var(--r-chip)', padding: '1px 5px' }}>
      {node.text}
    </code>
  ),
  math: (node, key) => <MathMarkup key={key} text={node.text} display={false} />,
  link: (node, key) => (
    <a key={key} href={node.href} target="_blank" rel="noreferrer" style={{ color: 'var(--proto-accent)', textDecoration: 'underline' }}>{node.text}</a>
  ),
  // The transcript renders untrusted model output, so an image reference stays inert text here:
  // fetching an arbitrary src from a chat message would be a new outbound request per message.
  image: (node, key) => <Fragment key={key}>{node.alt || node.src}</Fragment>,
};

function Inline({ nodes }: { nodes: InlineNode[] }): JSX.Element {
  return <>{nodes.map((node, key) => (INLINE_RENDERERS[node.type] as InlineRenderer)(node, key))}</>;
}

type BlockOf<T extends Block['type']> = Extract<Block, { type: T }>;
/** Render options a block may consult. Renderers that ignore them simply omit the parameter. */
type RenderCtx = { wideTables: boolean };
type BlockRenderer = (block: Block, ctx: RenderCtx) => JSX.Element | null;

function HeadingBlock({ block }: { block: BlockOf<'heading'> }): JSX.Element {
  const size = block.level <= 1 ? 17 : block.level === 2 ? 15.5 : 14.5;
  return (
    <div style={{ fontSize: size, fontWeight: 650, color: 'var(--proto-ink)', margin: '2px 0' }}>
      <Inline nodes={block.inline} />
    </div>
  );
}

function ListBlock({ block }: { block: BlockOf<'list'> }): JSX.Element {
  const Tag = block.ordered ? 'ol' : 'ul';
  return (
    <Tag style={{ margin: '2px 0', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {block.items.map((item, index) => <li key={index}><Inline nodes={item} /></li>)}
    </Tag>
  );
}

function CopyGlyph({ done }: { done: boolean }): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" strokeWidth="1.4" stroke={done ? 'var(--proto-success)' : 'currentColor'}>
      {done
        ? <path d="M3 7.4l2.6 2.6L11 4.6" strokeLinecap="round" strokeLinejoin="round" />
        : <><rect x="4.5" y="4.5" width="8" height="8" rx="1.5" /><path d="M2.5 9.5V3.5a1 1 0 0 1 1-1h6" /></>}
    </svg>
  );
}

// Hidden until the block is hovered or the button takes keyboard focus; a touch screen has no
// hover, so there it simply stays visible.
const CODE_COPY_REVEAL = [
  'pointer-events-none opacity-0 transition-opacity',
  'group-hover/code:pointer-events-auto group-hover/code:opacity-100',
  'focus-visible:pointer-events-auto focus-visible:opacity-100',
  '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
].join(' ');

function CodeBlock({ block }: { block: BlockOf<'code'> }): JSX.Element {
  const L = useVocabOptional();
  const { copiedKey, copy } = useClipboardFeedback<true>(1500);
  const copied = copiedKey === true;
  const label = copied ? L.wbCopied : L.wbCopy;
  return (
    // A named group: a message row is itself a `group`, and hovering the message must not reveal
    // the button of every code block inside it.
    <div className="group/code" style={{ position: 'relative', margin: '2px 0' }}>
      <pre style={{
        font: `500 12.5px ${mono}`,
        // Stays a filled block, not glass: code is read character by character and a translucent
        // ground under a monospace grid is exactly where legibility goes first.
        background: 'var(--proto-alt)',
        border: '1px solid var(--proto-line)',
        borderRadius: 'var(--r-card)',
        padding: '10px 12px',
        overflow: 'auto',
        margin: 0,
      }}>
        <code>{block.text}</code>
      </pre>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => { void copy(block.text, true); }}
        className={`${CODE_COPY_REVEAL} select-none text-proto-muted hover:text-proto-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--proto-accent)]`}
        style={{
          position: 'absolute', top: 6, right: 6, width: 24, height: 24, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          background: 'var(--proto-alt)', border: '1px solid var(--proto-line)', borderRadius: 'var(--r-chip)',
        }}
      >
        <CopyGlyph done={copied} />
      </button>
    </div>
  );
}

/** Cells wrap only once the table has hit its cap (see `TableBlock`) — until then the table is laid
 *  out at its max-content width, so a table that fits reads exactly as it did when cells were
 *  `nowrap`. `anywhere` rather than `break-word` so an unbreakable token (a long path, a hash)
 *  cannot hold the whole column above the cap and force a scrollbar on its own. */
const CELL: CSSProperties = { border: '1px solid var(--proto-line)', padding: '4px 8px', overflowWrap: 'anywhere' };

function TableHead({ header }: { header: InlineNode[][] }): JSX.Element {
  return (
    <thead>
      <tr>
        {header.map((cell, index) => (
          <th key={index} style={{ ...CELL, textAlign: 'left', fontWeight: 650 }}>
            <Inline nodes={cell} />
          </th>
        ))}
      </tr>
    </thead>
  );
}

function TableBody({ rows }: { rows: InlineNode[][][] }): JSX.Element {
  return (
    <tbody>
      {rows.map((row, rowIndex) => (
        <tr key={rowIndex}>
          {row.map((cell, cellIndex) => (
            <td key={cellIndex} style={CELL}>
              <Inline nodes={cell} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/** Narrowest column a wrapped table stays readable at. Wrapping to fit is an improvement only while
 *  the columns keep their shape; squeeze a six-column table into a phone and every cell becomes a
 *  one-word-per-line shred, which reads worse than swiping sideways. So the cap below never falls
 *  under `columns × MIN_COL_W`: past that count the table stops shrinking and scrolls instead. */
const MIN_COL_W = 96;

/** Widest a table may grow before its cells start wrapping, in two parts.
 *
 *  Reading width — a bled-out transcript table (`wide`) may reach `--chat-table-max-w`, twice the
 *  prose column, published by the host. A table that lives in a box it cannot break out of (mobile
 *  bubble, decision card, plan reader) gets `100%` of that box instead: it has nowhere to expand
 *  into, and a sideways scroll inside a vertically-scrolled feed is worse than a wrapped row.
 *  Column floor — `MIN_COL_W` per column, so column count, not just box width, decides.
 *
 *  Whichever is larger wins; the table takes `min(its own max-content, that)`. Under it nothing
 *  changes (no wrapping, no scrollbar); over it the cells wrap; over it AND wider than the visible
 *  box — a many-column table on a narrow pane — the block scrolls, as before. */
function tableMaxWidth(block: BlockOf<'table'>, wide: boolean): string {
  const columns = block.rows.reduce((max, row) => Math.max(max, row.length), block.header.length);
  // 200% is the fallback for a `wide` host that publishes no variable: `width` falls back to 100%
  // too, so the pair still means "twice the column this table sits in".
  return `max(${wide ? 'var(--chat-table-max-w, 200%)' : '100%'}, ${columns * MIN_COL_W}px)`;
}

/** Prose is capped to a readable column, but a table is data: folding it into that column costs
 *  far more than the extra width does. When the host opts in AND publishes `--chat-bleed-w` (the
 *  desktop transcript measures its own pane), the block breaks symmetrically out of the column and
 *  centres the table on the whole pane; anything wider than the cap still scrolls inside the block.
 *  Without the variable the calc collapses to zero, so every other host keeps the old box.
 *  `max-content` (not the default shrink-to-fit) is what lets a table outgrow the block and scroll
 *  rather than silently wrap to the pane; `maxWidth` is then the only thing that makes it wrap. */
function TableBlock({ block, wide }: { block: BlockOf<'table'>; wide: boolean }): JSX.Element {
  const width = wide ? 'var(--chat-bleed-w, 100%)' : '100%';
  return (
    <div style={{ width, marginLeft: wide ? `calc((100% - ${width}) / 2)` : undefined, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 13, margin: '0 auto', width: 'max-content', maxWidth: tableMaxWidth(block, wide) }}>
        <TableHead header={block.header} />
        <TableBody rows={block.rows} />
      </table>
    </div>
  );
}

const BLOCK_RENDERERS: Record<Block['type'], BlockRenderer> = {
  heading: (block) => <HeadingBlock block={block as BlockOf<'heading'>} />,
  paragraph: (block) => <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}><Inline nodes={(block as BlockOf<'paragraph'>).inline} /></div>,
  list: (block) => <ListBlock block={block as BlockOf<'list'>} />,
  code: (block) => <CodeBlock block={block as BlockOf<'code'>} />,
  math: (block) => <MathMarkup text={(block as BlockOf<'math'>).text} display />,
  blockquote: (block) => <div style={{ borderLeft: '3px solid var(--proto-line)', paddingLeft: 12, color: 'var(--proto-muted)' }}><Inline nodes={(block as BlockOf<'blockquote'>).inline} /></div>,
  table: (block, ctx) => <TableBlock block={block as BlockOf<'table'>} wide={ctx.wideTables} />,
  hr: () => <div style={{ height: 1, background: 'var(--proto-line-2)', margin: '4px 0' }} />,
};

function BlockView({ block, ctx }: { block: Block; ctx: RenderCtx }): JSX.Element | null {
  return BLOCK_RENDERERS[block.type](block, ctx);
}

export function ChatMarkdown({ text, dropTrailingHr = false, renderMath = false, wideTables = false }: {
  text: string;
  dropTrailingHr?: boolean;
  renderMath?: boolean;
  /** Opt-in (desktop transcript): let tables span the chat pane instead of the prose column. Off by
   *  default so hosts that own a narrow box of their own — decision cards, the plan reader, the
   *  mobile stream — are unaffected. */
  wideTables?: boolean;
}): JSX.Element {
  let blocks = parseBlocks(text, { math: renderMath });
  // Opt-in (mobile chat): assistant messages often close with a `---` separator, which renders as a
  // dangling horizontal rule at the bottom of the bubble. Trim any trailing hr block(s). Default off,
  // so the desktop renderer is unchanged.
  if (dropTrailingHr) {
    let end = blocks.length;
    while (end > 0 && blocks[end - 1].type === 'hr') end--;
    if (end !== blocks.length) blocks = blocks.slice(0, end);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} ctx={{ wideTables }} />
      ))}
    </div>
  );
}
