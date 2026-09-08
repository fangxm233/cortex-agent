import { describe, expect, it } from 'vitest';
import { accelItems, flattenItems, formatAccel, matchesAccel, parseAccel, type MenuDef } from './menu-model';

const key = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({
  key: 'a', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over,
});

describe('parseAccel', () => {
  it('splits modifiers from the key', () => {
    expect(parseAccel('mod+shift+n')).toEqual({ key: 'n', mod: true, shift: true, alt: false });
  });
  it('handles a bare function key', () => {
    expect(parseAccel('f11')).toEqual({ key: 'f11', mod: false, shift: false, alt: false });
  });
});

describe('formatAccel', () => {
  it('uses symbols on a command-key platform', () => {
    expect(formatAccel('mod+shift+n', true)).toBe('⌘⇧N');
    expect(formatAccel('mod+alt+b', true)).toBe('⌘⌥B');
  });
  it('spells modifiers out elsewhere', () => {
    expect(formatAccel('mod+shift+n', false)).toBe('Ctrl+Shift+N');
    expect(formatAccel('f11', false)).toBe('F11');
  });
  it('renders the zoom-in key as a plus', () => {
    expect(formatAccel('mod+=', false)).toBe('Ctrl++');
  });
});

describe('matchesAccel', () => {
  it('accepts either primary modifier', () => {
    expect(matchesAccel(key({ key: 'b', metaKey: true }), 'mod+b')).toBe(true);
    expect(matchesAccel(key({ key: 'b', ctrlKey: true }), 'mod+b')).toBe(true);
  });
  it('rejects a superset of modifiers', () => {
    expect(matchesAccel(key({ key: 'n', metaKey: true, shiftKey: true }), 'mod+n')).toBe(false);
  });
  it('is case insensitive on the key', () => {
    expect(matchesAccel(key({ key: 'B', ctrlKey: true }), 'mod+b')).toBe(true);
  });
  it('rejects a bare key when a modifier is required', () => {
    expect(matchesAccel(key({ key: 'b' }), 'mod+b')).toBe(false);
  });
});

const menus: MenuDef[] = [
  {
    id: 'view',
    label: 'View',
    items: [
      { kind: 'item', id: 'a', label: 'A', accel: 'mod+b', run: () => {} },
      { kind: 'separator' },
      {
        kind: 'submenu',
        id: 'sub',
        label: 'Sub',
        items: [{ kind: 'item', id: 'b', label: 'B', run: () => {} }],
      },
    ],
  },
];

describe('flattenItems / accelItems', () => {
  it('walks into submenus and drops separators', () => {
    expect(flattenItems(menus).map((item) => item.id)).toEqual(['a', 'b']);
  });
  it('keeps only items that declare an accelerator', () => {
    expect(accelItems(menus).map((item) => item.id)).toEqual(['a']);
  });
});
