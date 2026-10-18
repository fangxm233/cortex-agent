import type { ReactElement } from 'react';
import { create as createRenderer, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import { deriveMemoryDoc } from './memory-doc';
import { MemoryDocHeader } from './MemoryDocHeader';
import { MarkdownView } from './MarkdownView';

const EXP = [
  '---',
  'id: EXP-001',
  'date: 2026-10-14',
  'project: optimizer-study',
  'summary: Momentum 0.9 reached 97% fastest',
  'tags: [digits, mlp]',
  'status: valid',
  '---',
  '# EXP-001: Fixed-protocol optimizer comparison',
  '## Run command',
  '```',
  'python benchmark.py --output results/digits.json',
  '```',
  '## Results',
  '| Optimizer | Median s |',
  '|---|---|',
  '| SGD | 0.02722 |',
].join('\n');

// No window in this environment, so the provider settles on the default language (en).
function create(element: ReactElement) {
  return createRenderer(<LangProvider>{element}</LangProvider>);
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

function styles(root: ReactTestInstance): string {
  return root.findAll((n) => typeof n.type === 'string' && n.props.style).map((n) => JSON.stringify(n.props.style)).join('\n');
}

describe('MemoryDocHeader', () => {
  it('reads the frontmatter as a property line, title and lede — not a mono key/value card', () => {
    const onShowChanges = vi.fn();
    const doc = deriveMemoryDoc(EXP);
    const root = create(
      <MemoryDocHeader doc={doc} updated="Updated 16m ago" lineDiff={{ added: '+0', removed: '−0', clean: true }} onShowChanges={onShowChanges} />,
    ).root;

    expect(text(root.findByType('h1'))).toBe('Fixed-protocol optimizer comparison');
    expect(text(root.findByType('p'))).toBe('Momentum 0.9 reached 97% fastest');
    const all = text(root);
    for (const piece of [en.memKindExperiment, '2026-10-14', en.memStatusValid, 'digits', 'mlp', en.memNoLineChanges]) {
      expect(all).toContain(piece);
    }

    // The keys the line does not use stay reachable; an id value keeps the code face.
    const props = root.findByType('details');
    expect(text(props.findByType('summary'))).toContain(en.memProperties);
    const values = props.findAllByType('dd');
    expect(props.findAllByType('dt').map(text)).toEqual(['id', 'project']);
    expect(values[0].props.style.font).toContain('var(--font-code)');
    expect(values[1].props.style.font).toBeUndefined();

    // Nothing else in the header is mono or upper-cased.
    const css = styles(root).replace(/"font":"400 12px\/1\.7 var\(--font-code\)"/g, '');
    expect(css).not.toContain('font-code');
    expect(css).not.toContain('Plex');
    expect(css).not.toContain('uppercase');

    const link = root.findAllByType('button').find((b) => text(b) === en.memViewChanges)!;
    link.props.onClick();
    expect(onShowChanges).toHaveBeenCalledTimes(1);
  });

  it('omits the change link where the document is already shown in Changes mode', () => {
    const root = create(<MemoryDocHeader doc={deriveMemoryDoc(EXP)} updated="Updated 1m ago" lineDiff={null} />).root;
    expect(root.findAllByType('button').some((b) => text(b) === en.memViewChanges)).toBe(false);
  });
});

describe('MarkdownView', () => {
  it('anchors outlined headings, gives code a copy button and right-aligns numeric columns', () => {
    const doc = deriveMemoryDoc(EXP);
    const root = create(<MarkdownView blocks={doc.blocks} />).root;

    const headings = root.findAllByType('h2');
    expect(headings.map((h) => h.props.id)).toEqual(doc.outline.map((entry) => entry.id));
    expect(headings[0].props.style).toMatchObject({ fontSize: 17, fontWeight: 620 });

    const copy = root.findAllByType('button').find((b) => b.props['aria-label'] === en.wbCopy);
    expect(copy).toBeDefined();
    expect(root.findByType('pre').props.style.overflowX).toBe('auto');

    const [label, number] = root.findAllByType('th');
    expect(label.props.style.textAlign).toBe('left');
    expect(number.props.style.textAlign).toBe('right');
    expect(styles(root)).not.toContain('uppercase');
    expect(styles(root)).not.toContain('letterSpacing');
  });
});
