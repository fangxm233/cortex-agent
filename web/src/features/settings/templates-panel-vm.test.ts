// input:  vitest + templates-panel-vm
// output: coverage for filtering, selection fallback, editor parsing, save gating and the
//         detail-derived guards
// pos:    The gate rules are the contract worth pinning: a save is only offered when the text
//         parses, the name is filename-safe, and something actually changed — everything deeper is
//         the server's validator's job, and the VM must not second-guess it.
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, test, expect } from 'vitest';
import type { ThreadTemplateEntry, ThreadTemplateDetail } from '@cortex-agent/ui-contract';
import {
  filterEntries,
  countByFilter,
  resolveSelection,
  starterBody,
  formatBody,
  parseEditor,
  isDirty,
  validateName,
  saveGate,
  buildSaveArgs,
  needsRunningConfirm,
  deleteBlockedReason,
  forksFromDefaults,
  selectionKey,
  sameSelection,
} from './templates-panel-vm';

function entry(over: Partial<ThreadTemplateEntry> = {}): ThreadTemplateEntry {
  return {
    kind: 'template',
    name: 'coder-review',
    description: 'coder → reviewer',
    body: {},
    valid: true,
    errorCount: 0,
    origin: 'stock',
    ...over,
  };
}

function detail(over: Partial<ThreadTemplateDetail> = {}): ThreadTemplateDetail {
  return {
    kind: 'template',
    name: 'coder-review',
    description: null,
    body: {},
    filePath: '/tmp/coder-review.json',
    origin: 'custom',
    sha256: 'abc',
    errors: [],
    warnings: [],
    usedByTemplates: [],
    runningThreads: 0,
    referencingTasks: 0,
    expanded: null,
    ...over,
  };
}

const ENTRIES = [
  entry({ kind: 'template', name: 'coder-review', description: 'coder then reviewer' }),
  entry({ kind: 'agent', name: 'coder', description: 'writes code' }),
  entry({ kind: 'agent', name: 'analyst', description: 'reads results' }),
  entry({ kind: 'shell', name: 'worker-review', description: 'generic loop' }),
];

describe('filtering', () => {
  test('filters by kind', () => {
    expect(filterEntries(ENTRIES, 'agent', '').map((e) => e.name)).toEqual(['coder', 'analyst']);
    expect(filterEntries(ENTRIES, 'all', '')).toHaveLength(4);
  });

  test('searches name and description, case-insensitively', () => {
    expect(filterEntries(ENTRIES, 'all', 'CODER').map((e) => e.name)).toEqual(['coder-review', 'coder']);
    expect(filterEntries(ENTRIES, 'all', 'reads results').map((e) => e.name)).toEqual(['analyst']);
    expect(filterEntries(ENTRIES, 'agent', 'shell')).toEqual([]);
  });

  test('counts respect the active search', () => {
    expect(countByFilter(ENTRIES, '')).toEqual({ all: 4, template: 1, agent: 2, shell: 1 });
    expect(countByFilter(ENTRIES, 'coder')).toEqual({ all: 2, template: 1, agent: 1, shell: 0 });
  });
});

describe('selection', () => {
  test('keeps a requested selection while it is visible', () => {
    const requested = { kind: 'agent' as const, name: 'coder' };
    expect(resolveSelection(ENTRIES, requested)).toEqual(requested);
  });

  test('falls back to the first visible row when the request is filtered out', () => {
    const visible = filterEntries(ENTRIES, 'shell', '');
    expect(resolveSelection(visible, { kind: 'agent', name: 'coder' })).toEqual({
      kind: 'shell',
      name: 'worker-review',
    });
  });

  test('is null when nothing is visible', () => {
    expect(resolveSelection([], { kind: 'agent', name: 'coder' })).toBeNull();
  });

  test('key and equality helpers', () => {
    expect(selectionKey({ kind: 'agent', name: 'coder' })).toBe('agent:coder');
    expect(sameSelection({ kind: 'agent', name: 'a' }, { kind: 'agent', name: 'a' })).toBe(true);
    expect(sameSelection({ kind: 'agent', name: 'a' }, { kind: 'template', name: 'a' })).toBe(false);
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(null, { kind: 'agent', name: 'a' })).toBe(false);
  });
});

describe('starter skeletons', () => {
  test('every kind produces a parseable object carrying the new name', () => {
    for (const kind of ['agent', 'template', 'shell'] as const) {
      const body = starterBody(kind, 'fresh');
      const parsed = parseEditor(formatBody(body));
      expect(parsed.parseError).toBeNull();
      expect(parsed.body).toEqual(body);
    }
    expect(starterBody('agent', 'fresh').name).toBe('fresh');
    expect(starterBody('template', 'fresh').name).toBe('fresh');
    // Shells have no `name` field — the filename is their whole identity.
    expect(starterBody('shell', 'fresh')).not.toHaveProperty('name');
  });
});

describe('editor parsing', () => {
  test('accepts an object', () => {
    expect(parseEditor('{"a":1}')).toEqual({ body: { a: 1 }, parseError: null });
  });

  test('rejects arrays, scalars and empty text as a non-object body', () => {
    expect(parseEditor('[1,2]').parseError).toBe('Body must be a JSON object');
    expect(parseEditor('"str"').parseError).toBe('Body must be a JSON object');
    expect(parseEditor('null').parseError).toBe('Body must be a JSON object');
    expect(parseEditor('   ').parseError).toBe('Body is empty');
  });

  test('surfaces the parser message on malformed JSON', () => {
    const result = parseEditor('{ nope');
    expect(result.body).toBeNull();
    expect(result.parseError).toBeTruthy();
  });

  test('dirtiness is textual, so a whitespace-only edit still counts', () => {
    expect(isDirty('{"a":1}', '{"a":1}')).toBe(false);
    expect(isDirty('{"a": 1}', '{"a":1}')).toBe(true);
  });
});

describe('name validation', () => {
  test('accepts filename-safe names', () => {
    for (const name of ['coder', 'coder-review', 'a_b', 'x1']) {
      expect(validateName(name)).toBeNull();
    }
  });

  test('rejects anything that could escape the config directory', () => {
    for (const name of ['../evil', 'a/b', '.hidden', '-lead', '']) {
      expect(validateName(name)).not.toBeNull();
    }
  });
});

describe('save gating', () => {
  const base = { text: '{"a":2}', loaded: '{"a":1}', name: 'coder', creating: false };

  test('allows a dirty, parseable edit', () => {
    expect(saveGate(base)).toEqual({ canSave: true, reason: null });
  });

  test('blocks an unchanged edit', () => {
    expect(saveGate({ ...base, text: base.loaded })).toEqual({ canSave: false, reason: 'clean' });
  });

  test('blocks unparseable text', () => {
    expect(saveGate({ ...base, text: '{ nope' })).toEqual({ canSave: false, reason: 'parse' });
  });

  test('blocks a bad name only while creating', () => {
    expect(saveGate({ ...base, name: '../x', creating: true }).reason).toBe('name');
    // An existing entity is not renameable, so its name is not re-checked.
    expect(saveGate({ ...base, name: '../x', creating: false }).canSave).toBe(true);
  });

  test('a brand-new entity is saveable even though nothing has changed yet', () => {
    expect(saveGate({ ...base, text: base.loaded, creating: true }).canSave).toBe(true);
  });
});

describe('save args', () => {
  test('carry the base hash on update and omit it on create', () => {
    const common = { kind: 'agent' as const, name: 'coder', text: '{"a":2}', loaded: '{"a":1}', baseHash: 'h1' };
    expect(buildSaveArgs({ ...common, creating: false })).toEqual({
      kind: 'agent',
      name: 'coder',
      body: { a: 2 },
      baseHash: 'h1',
    });
    // Creating omits the hash entirely — the writer requires the file to be absent.
    expect(buildSaveArgs({ ...common, creating: true })).not.toHaveProperty('baseHash');
  });

  test('return null whenever the gate is closed', () => {
    expect(
      buildSaveArgs({ kind: 'agent', name: 'coder', text: '{ nope', loaded: '{}', creating: false, baseHash: 'h' }),
    ).toBeNull();
    expect(
      buildSaveArgs({ kind: 'agent', name: 'coder', text: '{}', loaded: '{}', creating: false, baseHash: 'h' }),
    ).toBeNull();
  });
});

describe('detail-derived guards', () => {
  test('a live thread demands a confirmation', () => {
    expect(needsRunningConfirm(detail({ runningThreads: 1 }))).toBe(true);
    expect(needsRunningConfirm(detail())).toBe(false);
    expect(needsRunningConfirm(null)).toBe(false);
  });

  test('delete is blocked by dependents first, then by live threads', () => {
    expect(deleteBlockedReason(detail({ usedByTemplates: ['x'], runningThreads: 2 }))).toBe('dependents');
    expect(deleteBlockedReason(detail({ runningThreads: 2 }))).toBe('running');
    expect(deleteBlockedReason(detail())).toBeNull();
    expect(deleteBlockedReason(null)).toBeNull();
  });

  test('only a stock entity warns about forking from the shipped default', () => {
    expect(forksFromDefaults(detail({ origin: 'stock' }))).toBe(true);
    expect(forksFromDefaults(detail({ origin: 'modified' }))).toBe(false);
    expect(forksFromDefaults(detail({ origin: 'custom' }))).toBe(false);
  });
});
