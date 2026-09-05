// input:  Markdown AST and optional KaTeX
// output: Chat Markdown with safe formula rendering and opt-in pane-wide tables
// pos:    Shared assistant Markdown renderer
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Fragment, type CSSProperties, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { parseBlocks, type Block, type InlineNode } from '@/features/memory/markdown';

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
    <code key={key} style={{ font: `500 12.5px ${mono}`, background: 'var(--proto-gray)', borderRadius: 4, padding: '1px 5px' }}>
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

function CodeBlock({ block }: { block: BlockOf<'code'> }): JSX.Element {
  return (
    <pre style={{
      font: `500 12.5px ${mono}`,
      background: 'var(--proto-alt)',
      border: '1px solid var(--proto-line)',
      borderRadius: 8,
      padding: '10px 12px',
      overflow: 'auto',
      margin: '2px 0',
    }}>
      <code>{block.text}</code>
    </pre>
  );
}

function TableHead({ header }: { header: InlineNode[][] }): JSX.Element {
  return (
    <thead>
      <tr>
        {header.map((cell, index) => (
          <th key={index} style={{ border: '1px solid var(--proto-line)', padding: '4px 8px', textAlign: 'left', fontWeight: 650, whiteSpace: 'nowrap' }}>
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
            <td key={cellIndex} style={{ border: '1px solid var(--proto-line)', padding: '4px 8px', whiteSpace: 'nowrap' }}>
              <Inline nodes={cell} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/** Prose is capped to a readable column, but a table is data: folding it into that column costs
 *  far more than the extra width does. When the host opts in AND publishes `--chat-bleed-w` (the
 *  desktop transcript measures its own pane), the block breaks symmetrically out of the column and
 *  centres the table on the whole pane; anything wider than that still scrolls inside the block.
 *  Without the variable the calc collapses to zero, so every other host keeps the old box. */
function TableBlock({ block, wide }: { block: BlockOf<'table'>; wide: boolean }): JSX.Element {
  const width = wide ? 'var(--chat-bleed-w, 100%)' : '100%';
  return (
    <div style={{ width, marginLeft: wide ? `calc((100% - ${width}) / 2)` : undefined, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 13, margin: '0 auto' }}>
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
