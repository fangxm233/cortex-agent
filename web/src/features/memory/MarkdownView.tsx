import {
  createContext, useContext, useEffect, useState,
  type CSSProperties, type ReactNode, Fragment,
} from 'react';
import { useVocab } from '@/i18n';
import { splitFrontmatter, parseBlocks, type InlineNode, type Block } from './markdown';

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
    return <span style={{ color: 'var(--proto-muted-3)' }}>{alt || src}</span>;
  }
  return <img src={url} alt={alt} style={{ maxWidth: '100%', borderRadius: 6, display: 'block', margin: '8px 0' }} />;
}

// Presentational Markdown renderer for the memory viewer 7b. Maps the pure markdown.ts
// nodes onto the prototype's exact typography (prototype.dc.html L685–716): frontmatter card +
// headings / paragraphs / lists / GFM tables / code / blockquote. Real file content is the variable.

const MONO = "'IBM Plex Mono',monospace";

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'bold':
        return (
          <span key={i} style={{ fontWeight: 650, color: 'var(--proto-ink-2)' }}>
            {n.text}
          </span>
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
            style={{ font: `400 .92em ${MONO}`, background: 'var(--proto-gray)', color: 'var(--proto-accent-strong)', padding: '1px 4px', borderRadius: 4 }}
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

const HEADING: CSSProperties = { fontSize: 12.5, fontWeight: 650, color: 'var(--proto-ink)', margin: '15px 0 5px' };
const PARA: CSSProperties = { fontSize: 11.5, lineHeight: 1.65, color: 'var(--proto-ink-3)', margin: '4px 0 0' };

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.type) {
    case 'heading':
      return (
        <div key={i} style={{ ...HEADING, fontSize: b.level >= 3 ? 11.5 : 12.5 }}>
          {renderInline(b.inline)}
        </div>
      );
    case 'paragraph':
      return (
        <div key={i} style={PARA}>
          {renderInline(b.inline)}
        </div>
      );
    case 'list':
      return (
        <div key={i} style={{ fontSize: 11.5, lineHeight: 1.75, color: 'var(--proto-ink-3)', margin: '4px 0 0' }}>
          {b.items.map((item, j) => (
            <div key={j} style={{ display: 'flex', gap: 9 }}>
              <span style={{ color: 'var(--proto-faint)', flex: 'none' }}>{b.ordered ? `${j + 1}.` : '·'}</span>
              <span>{renderInline(item)}</span>
            </div>
          ))}
        </div>
      );
    case 'table': {
      const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
      const grid = `repeat(${cols}, minmax(0,1fr))`;
      return (
        <div key={i} style={{ border: '1px solid var(--proto-line-2)', borderRadius: 8, overflow: 'hidden', fontSize: 11, margin: '7px 0 0' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: grid,
              padding: '6px 12px',
              background: 'var(--proto-rail)',
              borderBottom: '1px solid var(--proto-line-2)',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '.05em',
              color: 'var(--proto-muted-3)',
            }}
          >
            {b.header.map((cell, c) => (
              <span key={c}>{renderInline(cell)}</span>
            ))}
          </div>
          {b.rows.map((row, r) => (
            <div
              key={r}
              style={{
                display: 'grid',
                gridTemplateColumns: grid,
                padding: '6px 12px',
                borderBottom: '1px solid var(--proto-alt)',
                color: 'var(--proto-ink-3)',
              }}
            >
              {Array.from({ length: cols }).map((_, c) => (
                <span key={c} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 8 }}>
                  {row[c] ? renderInline(row[c]) : null}
                </span>
              ))}
            </div>
          ))}
        </div>
      );
    }
    case 'code':
      return (
        <pre
          key={i}
          style={{
            background: 'var(--proto-rail)',
            border: '1px solid var(--proto-line-2)',
            borderRadius: 8,
            padding: '10px 13px',
            font: `400 10.5px ${MONO}`,
            color: 'var(--proto-ink-2)',
            overflow: 'auto',
            margin: '7px 0 0',
            whiteSpace: 'pre',
          }}
        >
          {b.text}
        </pre>
      );
    case 'blockquote':
      return (
        <div
          key={i}
          style={{ borderLeft: '2px solid var(--proto-line-3)', padding: '2px 0 2px 9px', margin: '7px 0 0', fontSize: 11.5, lineHeight: 1.65, color: 'var(--proto-muted)' }}
        >
          {renderInline(b.inline)}
        </div>
      );
    case 'hr':
      return <div key={i} style={{ height: 1, background: 'var(--proto-line-2)', margin: '12px 0' }} />;
    default:
      return null;
  }
}

export function MarkdownView({ content, resolveImage }: {
  content: string;
  resolveImage?: MarkdownImageResolver;
}): JSX.Element {
  const L = useVocab();
  const { frontmatter, body } = splitFrontmatter(content);
  const blocks = parseBlocks(body);
  return (
    <ImageResolverContext.Provider value={resolveImage ?? null}>
    <div>
      {frontmatter && (frontmatter.entries.length > 0 || frontmatter.summary) && (
        <div style={{ background: 'var(--proto-rail)', border: '1px solid var(--proto-line-2)', borderRadius: 8, padding: '10px 13px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, font: `400 10px ${MONO}`, color: 'var(--proto-muted)', flexWrap: 'wrap' }}>
            {frontmatter.entries.map((e, i) => (
              <span key={i}>
                <span style={{ color: 'var(--proto-muted-3)' }}>{e.key}</span> {e.value}
              </span>
            ))}
          </div>
          {frontmatter.summary && (
            <div style={{ fontSize: 11, color: 'var(--proto-ink-2)', marginTop: 6 }}>
              <span style={{ font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)' }}>{L.memSummary}</span>&nbsp; {frontmatter.summary}
            </div>
          )}
        </div>
      )}
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
    </ImageResolverContext.Provider>
  );
}
