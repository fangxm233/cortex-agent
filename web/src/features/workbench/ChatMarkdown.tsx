import { Fragment } from 'react';
import { parseBlocks, type Block, type InlineNode } from '@/features/memory/markdown';

// Lightweight Markdown renderer for chat assistant messages. Reuses the pure, tested block/inline
// parser from the memory viewer (`features/memory/markdown.ts`) — headings, paragraphs, lists, fenced
// code, inline bold/italic/code/links — with chat-tuned typography. Plain text with newlines still
// renders correctly because the parser emits paragraphs split on blank lines and `white-space:
// pre-wrap` preserves single line breaks inside a paragraph.

const mono = "'IBM Plex Mono',monospace";

function Inline({ nodes }: { nodes: InlineNode[] }): JSX.Element {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'bold':
            return <strong key={i} style={{ fontWeight: 650 }}>{n.text}</strong>;
          case 'italic':
            return <em key={i}>{n.text}</em>;
          case 'code':
            return (
              <code key={i} style={{ font: `500 12.5px ${mono}`, background: 'var(--proto-gray)', borderRadius: 4, padding: '1px 5px' }}>
                {n.text}
              </code>
            );
          case 'link':
            return (
              <a key={i} href={n.href} target="_blank" rel="noreferrer" style={{ color: 'var(--proto-accent)', textDecoration: 'underline' }}>
                {n.text}
              </a>
            );
          default:
            return <Fragment key={i}>{n.text}</Fragment>;
        }
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }): JSX.Element | null {
  switch (block.type) {
    case 'heading': {
      const size = block.level <= 1 ? 17 : block.level === 2 ? 15.5 : 14.5;
      return (
        <div style={{ fontSize: size, fontWeight: 650, color: 'var(--proto-ink)', margin: '2px 0' }}>
          <Inline nodes={block.inline} />
        </div>
      );
    }
    case 'paragraph':
      return (
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
          <Inline nodes={block.inline} />
        </div>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag style={{ margin: '2px 0', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline nodes={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'code':
      return (
        <pre
          style={{
            font: `500 12.5px ${mono}`,
            background: 'var(--proto-alt)',
            border: '1px solid var(--proto-line)',
            borderRadius: 8,
            padding: '10px 12px',
            overflow: 'auto',
            margin: '2px 0',
          }}
        >
          <code>{block.text}</code>
        </pre>
      );
    case 'blockquote':
      return (
        <div style={{ borderLeft: '3px solid var(--proto-line)', paddingLeft: 12, color: 'var(--proto-muted)' }}>
          <Inline nodes={block.inline} />
        </div>
      );
    case 'table':
      // Don't cap the table's horizontal size — let it take its natural width (cells stay on one
      // line, no squish). Instead cap the WRAPPER at the bubble width and let it scroll horizontally,
      // so a wide table produces a scrollbar rather than stretching the chat pane. `maxWidth:100%`
      // keeps the scroll container inside its bubble (the assistant blocks already carry `minWidth:0`).
      return (
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={{ border: '1px solid var(--proto-line)', padding: '4px 8px', textAlign: 'left', fontWeight: 650, whiteSpace: 'nowrap' }}>
                    <Inline nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ border: '1px solid var(--proto-line)', padding: '4px 8px', whiteSpace: 'nowrap' }}>
                      <Inline nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <div style={{ height: 1, background: 'var(--proto-line-2)', margin: '4px 0' }} />;
    default:
      return null;
  }
}

export function ChatMarkdown({ text, dropTrailingHr = false }: { text: string; dropTrailingHr?: boolean }): JSX.Element {
  let blocks = parseBlocks(text);
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
