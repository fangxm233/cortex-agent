import { describe, it, expect } from 'vitest';
import { parseInline } from '@/lib/markdown';
import {
  activeOutlineId,
  deriveMemoryDoc,
  edgeFadeMask,
  splitBleed,
  isCodeValue,
  isNumericCell,
  numericColumns,
  parseFlowList,
  parseStatus,
} from './memory-doc';

const EXP = [
  '---',
  'id: EXP-001',
  'date: 2026-10-14',
  'project: optimizer-study',
  'summary: "Momentum 0.9 reached 97% fastest"',
  'tags: [digits, mlp, optimizer]',
  'status: valid',
  'executor: Cortex',
  'links: []',
  'evidence: [EXP-000, results/digits.json]',
  '---',
  '# EXP-001: Fixed-protocol optimizer comparison on digits',
  '',
  '## Background',
  'The approved plan.',
  '',
  '## Run `command`',
  '```',
  'python benchmark.py',
  '```',
  '### Seeds',
  '#### Too deep for the outline',
  '## Results',
].join('\n');

describe('deriveMemoryDoc — frontmatter split', () => {
  it('moves kind · date · status · tags to the property line and summary to the lede', () => {
    const doc = deriveMemoryDoc(EXP);
    expect(doc.kind).toBe('experiment'); // from the EXP- id prefix
    expect(doc.kindRaw).toBeNull();
    expect(doc.date).toBe('2026-10-14');
    expect(doc.status).toEqual({ key: 'valid', raw: 'valid', ref: null, tone: 'success' });
    expect(doc.tags).toEqual(['digits', 'mlp', 'optimizer']);
    expect(doc.summary).toBe('Momentum 0.9 reached 97% fastest');
  });

  it('keeps every other key, in file order, as a discoverable property', () => {
    const doc = deriveMemoryDoc(EXP);
    expect(doc.properties.map((p) => p.key)).toEqual(['id', 'project', 'executor', 'links', 'evidence']);
    expect(doc.properties.find((p) => p.key === 'id')).toMatchObject({ value: 'EXP-001', code: true });
    expect(doc.properties.find((p) => p.key === 'project')).toMatchObject({ value: 'optimizer-study', code: false });
    expect(doc.properties.find((p) => p.key === 'executor')!.code).toBe(false);
    expect(doc.properties.find((p) => p.key === 'links')).toMatchObject({ value: '—', code: false });
    expect(doc.properties.find((p) => p.key === 'evidence')).toMatchObject({
      value: 'EXP-000, results/digits.json',
      code: true,
    });
  });

  it('prefers a declared type and shows an unknown one verbatim', () => {
    expect(deriveMemoryDoc('---\nid: EXP-1\ntype: Pattern\n---\nx').kind).toBe('pattern');
    const custom = deriveMemoryDoc('---\nkind: retro\n---\nx');
    expect(custom).toMatchObject({ kind: null, kindRaw: 'retro' });
    expect(deriveMemoryDoc('---\nid: K-005\n---\nx').kind).toBe('knowledge');
    expect(deriveMemoryDoc('---\nid: PAT-001\n---\nx').kind).toBe('pattern');
  });

  it('handles a file with no frontmatter: no property line, no lede, no properties', () => {
    const doc = deriveMemoryDoc('# Mission\n\nShip it.');
    expect(doc).toMatchObject({ kind: null, date: null, status: null, tags: [], summary: null, properties: [] });
    expect(doc.title).toBe('Mission');
  });
});

describe('deriveMemoryDoc — title and outline', () => {
  it('takes the leading H1 as the title, dropping a repeated id prefix', () => {
    const doc = deriveMemoryDoc(EXP);
    expect(doc.title).toBe('Fixed-protocol optimizer comparison on digits');
    expect(doc.blocks[0].block.type).toBe('heading'); // the H1 itself is no longer a body block
    expect(doc.blocks.some((b) => b.block.type === 'heading' && b.block.level === 1)).toBe(false);
  });

  it('keeps the whole heading when it is only the id, and has no title without a leading H1', () => {
    expect(deriveMemoryDoc('---\nid: EXP-9\n---\n# EXP-9\n').title).toBe('EXP-9');
    expect(deriveMemoryDoc('## Notes\n\ntext').title).toBeNull();
  });

  it('builds the outline from h2/h3 headings with anchors matching the body blocks', () => {
    const doc = deriveMemoryDoc(EXP);
    expect(doc.outline.map((e) => [e.text, e.depth])).toEqual([
      ['Background', 0],
      ['Run command', 0],
      ['Seeds', 1],
      ['Results', 0],
    ]);
    const anchors = doc.blocks.filter((b) => b.anchor).map((b) => b.anchor);
    for (const entry of doc.outline) expect(anchors).toContain(entry.id);
    expect(new Set(anchors).size).toBe(anchors.length);
    // The h4 still gets an anchor, it just stays out of the outline.
    expect(anchors.length).toBe(doc.outline.length + 1);
  });

  it('returns an empty outline for a document without section headings', () => {
    expect(deriveMemoryDoc('# Only a title\n\nBody.').outline).toEqual([]);
  });
});

describe('frontmatter value helpers', () => {
  it('parses YAML flow lists, keeping quoted commas in their item', () => {
    expect(parseFlowList('[a, "b, c", d]')).toEqual(['a', 'b, c', 'd']);
    expect(parseFlowList('[]')).toEqual([]);
    expect(parseFlowList('solo')).toEqual(['solo']);
    expect(parseFlowList('')).toEqual([]);
  });

  it('sets only ids, paths and hashes in the code face', () => {
    expect(isCodeValue('EXP-001')).toBe(true);
    expect(isCodeValue('[EXP-001, K-002]')).toBe(true);
    expect(isCodeValue('plan/optimizer-study.md')).toBe(true);
    expect(isCodeValue('e1ef5b8')).toBe(true);
    expect(isCodeValue('Cortex')).toBe(false);
    expect(isCodeValue('optimizer-study')).toBe(false);
    expect(isCodeValue('[EXP-001, the baseline run]')).toBe(false);
  });

  it('reads lifecycle statuses with their target and tone', () => {
    expect(parseStatus('superseded:EXP-012')).toEqual({ key: 'superseded', raw: 'superseded:EXP-012', ref: 'EXP-012', tone: 'muted' });
    expect(parseStatus('challenged:EXP-3')!.tone).toBe('amber');
    expect(parseStatus('invalidated:EXP-4')!.tone).toBe('danger');
    expect(parseStatus('Active')).toMatchObject({ key: 'active', tone: 'success' });
    expect(parseStatus('on-hold')).toEqual({ key: null, raw: 'on-hold', ref: null, tone: 'muted' });
    expect(parseStatus('')).toBeNull();
    expect(parseStatus(undefined)).toBeNull();
  });
});

describe('numeric table columns', () => {
  const cells = (...texts: string[]) => texts.map((t) => parseInline(t));

  it('recognises numbers, percentages, fractions, units and slash-joined seeds', () => {
    for (const t of ['18', '0.00957', '97.50%', '3/3', '12 / 69 / 18', '150 ms', '−0.4', '1e-8', '$1.30']) {
      expect(isNumericCell(t)).toBe(true);
    }
    for (const t of ['SGD', 'Momentum 0.9', '2026-10-14', '', 'v2']) expect(isNumericCell(t)).toBe(false);
  });

  it('right-aligns a column of numbers (blanks allowed) and leaves text columns alone', () => {
    const header = cells('Optimizer', 'Reached 97%', 'Median s', 'Note');
    const rows = [
      cells('SGD', '3/3', '0.02722', 'baseline'),
      cells('**Momentum 0.9**', '**3/3**', '—', '12'),
    ];
    expect(numericColumns(header, rows)).toEqual([false, true, true, false]);
  });
});

describe('activeOutlineId', () => {
  const tops = [
    { id: 'a', top: -300 },
    { id: 'b', top: 20 },
    { id: 'c', top: 400 },
  ];

  it('picks the last heading at or above the threshold', () => {
    expect(activeOutlineId(tops, 48, false)).toBe('b');
  });

  it('falls back to the first heading before any reached the threshold, and the last at the end', () => {
    expect(activeOutlineId([{ id: 'a', top: 200 }, { id: 'b', top: 500 }], 48, false)).toBe('a');
    expect(activeOutlineId(tops, 48, true)).toBe('c');
    expect(activeOutlineId([], 48, false)).toBeNull();
  });

  it('keeps a heading jumped to from the outline current, even where it cannot reach the top', () => {
    // Jumped to `b` near the end of a short page: the scroll settles at the end with `b` well below
    // the threshold, where the plain rules would name `c` (end) or `a` (threshold).
    const settled = [
      { id: 'a', top: -300 },
      { id: 'b', top: 160 },
      { id: 'c', top: 420 },
    ];
    expect(activeOutlineId(settled, 48, true)).toBe('c');
    expect(activeOutlineId(settled, 48, false)).toBe('a');
    expect(activeOutlineId(settled, 48, true, 'b')).toBe('b');
    expect(activeOutlineId(settled, 48, false, 'b')).toBe('b');
  });

  it('ignores a pin that is not a heading of this page', () => {
    expect(activeOutlineId(tops, 48, true, 'gone')).toBe('c');
    expect(activeOutlineId([], 48, false, 'b')).toBeNull();
  });
});

describe('splitBleed', () => {
  it('stays centred under the column while both sides have room', () => {
    expect(splitBleed(100, 200, 200)).toEqual({ left: 50, right: 50 });
  });

  it('leans into the side with room once the other runs out, never past either', () => {
    expect(splitBleed(100, 200, 0)).toEqual({ left: 100, right: 0 });
    expect(splitBleed(100, 30, 200)).toEqual({ left: 30, right: 70 });
    expect(splitBleed(1000, 120, 80)).toEqual({ left: 120, right: 80 });
  });

  it('does not reach out for a table that fits the column', () => {
    expect(splitBleed(0, 200, 200)).toEqual({ left: 0, right: 0 });
    expect(splitBleed(-40, 200, 200)).toEqual({ left: 0, right: 0 });
  });
});

describe('edgeFadeMask', () => {
  it('fades only the edges that hide content, and nothing at rest or at the scroll end', () => {
    expect(edgeFadeMask(false, false)).toBeUndefined();
    expect(edgeFadeMask(false, true)).toBe('linear-gradient(to right, #000, #000 calc(100% - 44px), transparent)');
    expect(edgeFadeMask(true, false)).toBe('linear-gradient(to right, transparent, #000 24px, #000)');
    expect(edgeFadeMask(true, true)).toBe('linear-gradient(to right, transparent, #000 24px, #000 calc(100% - 44px), transparent)');
  });
});
