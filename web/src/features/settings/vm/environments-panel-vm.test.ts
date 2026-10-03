import { describe, test, expect } from 'vitest';
import type { EnvironmentEntry, EnvironmentDetail } from '@cortex-agent/ui-contract';
import {
  filterEntries,
  resolveSelection,
  starterBody,
  formatBody,
  parseEditor,
  isDirty,
  validateName,
  saveGate,
  buildSaveArgs,
  canDelete,
  forksFromDefaults,
} from './environments-panel-vm';

function entry(over: Partial<EnvironmentEntry> = {}): EnvironmentEntry {
  return {
    name: 'main',
    description: 'general work',
    body: {},
    valid: true,
    errorCount: 0,
    origin: 'stock',
    ...over,
  };
}

function detail(over: Partial<EnvironmentDetail> = {}): EnvironmentDetail {
  return {
    name: 'main',
    description: null,
    body: {},
    filePath: '/tmp/main.json',
    origin: 'custom',
    sha256: 'abc',
    errors: [],
    warnings: [],
    ...over,
  };
}

const ENTRIES = [
  entry({ name: 'main', description: 'general work' }),
  entry({ name: 'creative', description: 'writing and ideas' }),
  entry({ name: 'analyst', description: 'reads results' }),
];

describe('filtering', () => {
  test('an empty search shows everything', () => {
    expect(filterEntries(ENTRIES, '')).toHaveLength(3);
  });

  test('searches name and description, case-insensitively', () => {
    expect(filterEntries(ENTRIES, 'CREAT').map((e) => e.name)).toEqual(['creative']);
    expect(filterEntries(ENTRIES, 'reads results').map((e) => e.name)).toEqual(['analyst']);
    expect(filterEntries(ENTRIES, 'nothing')).toEqual([]);
  });
});

describe('selection', () => {
  test('keeps a requested selection while it is visible', () => {
    expect(resolveSelection(ENTRIES, 'creative')).toBe('creative');
  });

  test('falls back to the first visible row when the request is filtered out', () => {
    const visible = filterEntries(ENTRIES, 'reads');
    expect(resolveSelection(visible, 'creative')).toBe('analyst');
  });

  test('is null when nothing is visible', () => {
    expect(resolveSelection([], 'main')).toBeNull();
  });
});

describe('starter skeleton', () => {
  test('produces a parseable object', () => {
    const body = starterBody();
    const parsed = parseEditor(formatBody(body));
    expect(parsed.parseError).toBeNull();
    expect(parsed.body).toEqual(body);
  });
});

describe('editor parsing', () => {
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
    for (const name of ['main', 'deep-work', 'a_b', 'x1']) {
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
  const base = { text: '{"a":2}', loaded: '{"a":1}', name: 'main', creating: false };

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
    // An existing environment is not renameable, so its name is not re-checked.
    expect(saveGate({ ...base, name: '../x', creating: false }).canSave).toBe(true);
  });

  test('a brand-new environment is saveable even though nothing has changed yet', () => {
    expect(saveGate({ ...base, text: base.loaded, creating: true }).canSave).toBe(true);
  });
});

describe('save args', () => {
  test('carry the base hash on update and omit it on create', () => {
    const common = { name: 'main', text: '{"a":2}', loaded: '{"a":1}', baseHash: 'h1' };
    expect(buildSaveArgs({ ...common, creating: false })).toEqual({ name: 'main', body: { a: 2 }, baseHash: 'h1' });
    // Creating omits the hash entirely — the writer requires the file to be absent.
    expect(buildSaveArgs({ ...common, creating: true })).not.toHaveProperty('baseHash');
  });

  test('return null whenever the gate is closed', () => {
    expect(buildSaveArgs({ name: 'main', text: '{ nope', loaded: '{}', creating: false, baseHash: 'h' })).toBeNull();
    expect(buildSaveArgs({ name: 'main', text: '{}', loaded: '{}', creating: false, baseHash: 'h' })).toBeNull();
  });
});

describe('detail-derived guards', () => {
  test('the default environment cannot be deleted', () => {
    expect(canDelete('main')).toBe(false);
    expect(canDelete('creative')).toBe(true);
  });

  test('only a stock environment warns about forking from the shipped default', () => {
    expect(forksFromDefaults(detail({ origin: 'stock' }))).toBe(true);
    expect(forksFromDefaults(detail({ origin: 'modified' }))).toBe(false);
    expect(forksFromDefaults(detail({ origin: 'custom' }))).toBe(false);
    expect(forksFromDefaults(null)).toBe(false);
  });
});
