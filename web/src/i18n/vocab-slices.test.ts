// vocab.ts merges the slices with object spread, where a duplicate key silently overwrites the
// earlier slice. Every slice module is discovered here, so a new slice is covered automatically.
import { describe, expect, it } from 'vitest';
import { en, zh } from './vocab';

const modules = import.meta.glob<Record<string, unknown>>(['./*vocab*.ts', '!./vocab.ts', '!./*.test.ts'], { eager: true });

function slices(lang: 'en' | 'zh'): [string, object][] {
  const name = lang === 'en' ? /(^en[A-Z]|En$)/ : /(^zh[A-Z]|Zh$)/;
  return Object.entries(modules).flatMap(([file, exports]) => Object.entries(exports)
    .filter(([exportName, value]) => name.test(exportName) && typeof value === 'object' && value !== null)
    .map(([exportName, value]): [string, object] => [`${file}:${exportName}`, value as object]));
}

function duplicates(parts: [string, object][]): string[] {
  const owner = new Map<string, string>();
  const dupes: string[] = [];
  for (const [slice, value] of parts) {
    for (const key of Object.keys(value)) {
      const first = owner.get(key);
      if (first) dupes.push(`${key}: ${first} / ${slice}`);
      else owner.set(key, slice);
    }
  }
  return dupes;
}

describe.each([['en', en], ['zh', zh]] as const)('%s vocab slices', (lang, merged) => {
  const parts = slices(lang);

  it('have pairwise-disjoint keys', () => {
    expect(duplicates(parts)).toEqual([]);
  });

  it('are all merged into the vocab', () => {
    const keys = parts.flatMap(([, value]) => Object.keys(value)).sort();
    expect(keys).toEqual(Object.keys(merged).sort());
  });
});
