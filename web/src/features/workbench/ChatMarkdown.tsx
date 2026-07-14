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
              <code key={i} style={{ font: `500 12.5px ${mono}`, background: '#F1F2F5', borderRadius: 4, padding: '1px 5px' }}>
                {n.text}
              </code>
            );
          case 'link':
            return (
              <a key={i} href={n.href} target="_blank" rel="noreferrer" style={{ color: '#4655D4', textDecoration: 'underline' }}>
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
        <div style={{ fontSize: size, fontWeight: 650, color: '#191C22', margin: '2px 0' }}>
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
            background: '#F7F8FA',
            border: '1px solid #E7E9EE',
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
        <div style={{ borderLeft: '3px solid #E7E9EE', paddingLeft: 12, color: '#5B6472' }}>
          <Inline nodes={block.inline} />
        </div>
      );
    case 'table':
      return (
        <div style={{ overflow: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={{ border: '1px solid #E7E9EE', padding: '4px 8px', textAlign: 'left', fontWeight: 650 }}>
                    <Inline nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ border: '1px solid #E7E9EE', padding: '4px 8px' }}>
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
      return <div style={{ height: 1, background: '#EFF1F5', margin: '4px 0' }} />;
    default:
      return null;
  }
}

export function ChatMarkdown({ text }: { text: string }): JSX.Element {
  const blocks = parseBlocks(text);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}
