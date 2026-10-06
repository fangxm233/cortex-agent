import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRailTreeState } from './useRailTreeState';

let store: Map<string, string>;
let rail: ReturnType<typeof useRailTreeState>;
let renderer: ReactTestRenderer;
function Probe() { rail = useRailTreeState(); return null; }

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  } });
  act(() => { renderer = create(<Probe />); });
});
afterEach(() => { act(() => renderer.unmount()); vi.unstubAllGlobals(); });

it('persists open folders and forgets "show all" when a folder closes', () => {
  act(() => rail.openProject('p'));
  act(() => rail.showAllIn('p'));
  expect(JSON.parse(store.get('cortex.railExpanded')!)).toEqual(['p']);
  expect(rail.view.showAll.has('p')).toBe(true);
  act(() => rail.toggleProject('p'));
  expect(rail.view.expanded.has('p')).toBe(false);
  expect(rail.view.showAll.has('p')).toBe(false);
});

it('clears the filter when the search closes', () => {
  act(() => rail.openSearch());
  act(() => rail.setFilter('grasp'));
  expect(rail.view.filter).toBe('grasp');
  act(() => rail.toggleSearch());
  expect(rail.searchOpen).toBe(false);
  expect(rail.view.filter).toBe('');
});

it('marks a reorder as a drag until activity retires it', () => {
  act(() => rail.reorder('b', 'a', ['a', 'b']));
  expect(rail.view.manualOrder).toEqual(['b', 'a']);
  expect(rail.view.dragged).toBe(true);
  act(() => rail.retireDrag());
  expect(rail.view.dragged).toBe(false);
  act(() => rail.sortBy('manual', ['a', 'b']));
  expect(store.get('cortex.railSort')).toBe('manual');
  expect(rail.view.manualOrder).toEqual(['b', 'a']);
});
