// input:  Markdown AST and optional KaTeX
// output: Chat-styled Markdown with safe formula rendering
// pos:    Shared assistant Markdown renderer
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Fragment, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { parseBlocks, type Block, type InlineNode } from '@/features/memory/markdown';

const mono = "'IBM Plex Mono',monospace";
type InlineRenderer = (node: InlineNode, key: number) => ReactNode;

function MathMarkup({ text, display }: { text: string; display: boolean }): JSX.Element {
  const markup = katex.renderToString(text, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    maxExpand: 1000,
    maxSize: 50,
  });
  const style = display
    ? { overflowX: 'auto' as const, overflowY: 'hidden' as const, maxWidth: '100%' }
    : { display: 'inline-block', maxWidth: '100%', overflowX: 'auto' as const, verticalAlign: 'middle' };
  const Tag = display ? 'div' : 'span';
  return <Tag style={style} dangerouslySetInnerHTML={{ __html: markup }} />;
}

const INLINE_RENDERERS: Record<InlineNode['type'], InlineRenderer> = {
  text: (node, key) => <Fragment key={key}>{node.text}</Fragment>,
  bold: (node, key) => <strong key={key} style={{ fontWeight: 650 }}>{node.text}</strong>,
  italic: (node, key) => <em key={key}>{node.text}</em>,
  code: (node, key) => (
    <code key={key} style={{ font: `500 12.5px ${mono}`, background: 'var(--proto-gray)', borderRadius: 4, padding: '1px 5px' }}>
      {node.text}
    </code>
  ),
  math: (node, key) => <MathMarkup key={key} text={node.text} display={false} />,
  link: (node, key) => {
    const link = node as Extract<InlineNode, { type: 'link' }>;
    return <a key={key} href={link.href} target="_blank" rel="noreferrer" style={{ color: 'var(--proto-accent)', textDecoration: 'underline' }}>{link.text}</a>;
  },
};

function Inline({ nodes }: { nodes: InlineNode[] }): JSX.Element {
  return <>{nodes.map((node, key) => INLINE_RENDERERS[node.type](node, key))}</>;
}

type BlockOf<T extends Block['type']> = Extract<Block, { type: T }>;
type BlockRenderer = (block: Block) => JSX.Element | null;

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

function TableBlock({ block }: { block: BlockOf<'table'> }): JSX.Element {
  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
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
  table: (block) => <TableBlock block={block as BlockOf<'table'>} />,
  hr: () => <div style={{ height: 1, background: 'var(--proto-line-2)', margin: '4px 0' }} />,
};

function BlockView({ block }: { block: Block }): JSX.Element | null {
  return BLOCK_RENDERERS[block.type](block);
}

export function ChatMarkdown({ text, dropTrailingHr = false, renderMath = false }: {
  text: string;
  dropTrailingHr?: boolean;
  renderMath?: boolean;
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
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}
