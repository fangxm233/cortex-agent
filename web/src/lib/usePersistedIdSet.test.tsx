import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePersistedIdSet, type PersistedIdSet } from './usePersistedIdSet';

let store: Map<string, string>;
let set: PersistedIdSet;
let renders = 0;
let renderer: ReactTestRenderer;
function Probe({ storageKey }: { storageKey: string }) { renders++; set = usePersistedIdSet(storageKey); return null; }
const mount = (key = 'k') => act(() => { renderer = create(<Probe storageKey={key} />); });

beforeEach(() => {
  store = new Map();
  renders = 0;
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  } });
});
afterEach(() => { act(() => renderer.unmount()); vi.unstubAllGlobals(); });

it('loads the stored ids, dropping anything that is not a string', () => {
  store.set('k', JSON.stringify(['a', 3, 'b']));
  mount();
  expect([...set.ids]).toEqual(['a', 'b']);
});

it('starts empty on malformed storage', () => {
  store.set('k', '{not json');
  mount();
  expect(set.ids.size).toBe(0);
});

it('toggles, adds and removes, persisting each change', () => {
  mount();
  act(() => set.toggle('a'));
  act(() => set.add('b'));
  expect(JSON.parse(store.get('k')!)).toEqual(['a', 'b']);
  act(() => set.toggle('a'));
  act(() => set.remove('b'));
  expect(JSON.parse(store.get('k')!)).toEqual([]);
});

it('keeps the same set for a no-op add or remove', () => {
  store.set('k', JSON.stringify(['a']));
  mount();
  const before = renders;
  act(() => set.add('a'));
  act(() => set.remove('z'));
  expect(renders).toBe(before);
});
