// input:  accelerator strings and menu item declarations
// output: parsing, display formatting and keyboard matching for menu accelerators
// pos:    Pure rules shared by the menu bar, its shortcuts and the shortcuts sheet
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// One declaration drives three consumers: the dropdown's right-hand hint, the global key handler,
// and the Help → Keyboard shortcuts sheet. Before this, the app had four ad-hoc `keydown` listeners
// and no registry at all, so a shortcut could not be discovered from the UI.
//
// `mod` is Cmd on macOS and Ctrl everywhere else — the same rule the existing handlers already use
// (`event.metaKey || event.ctrlKey`).

export interface ParsedAccel {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

export function parseAccel(accel: string): ParsedAccel {
  const parts = accel.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  return {
    key,
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
}

const KEY_LABELS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  '=': '+',
  ',': ',',
};

export function formatAccel(accel: string, commandKey: boolean): string {
  const { key, mod, shift, alt } = parseAccel(accel);
  const parts: string[] = [];
  if (mod) parts.push(commandKey ? '⌘' : 'Ctrl');
  if (shift) parts.push(commandKey ? '⇧' : 'Shift');
  if (alt) parts.push(commandKey ? '⌥' : 'Alt');
  const label = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key.replace(/^f(\d+)$/, 'F$1'));
  parts.push(label);
  return commandKey ? parts.join('') : parts.join('+');
}

interface KeyboardLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function matchesAccel(event: KeyboardLike, accel: string): boolean {
  const { key, mod, shift, alt } = parseAccel(accel);
  if (mod !== (event.metaKey || event.ctrlKey)) return false;
  if (shift !== event.shiftKey) return false;
  if (alt !== event.altKey) return false;
  return event.key.toLowerCase() === key;
}

export type MenuNode =
  | {
      kind: 'item';
      id: string;
      label: string;
      accel?: string;
      /** Show the accelerator, but do not bind it. Either the webview implements it natively
       *  (the clipboard block) or another owner already binds it (⌘K lives with the palette's own
       *  state). Binding it twice would double-fire, and for ⌘K the synthetic re-dispatch would
       *  recurse. The shortcuts sheet still lists these — they are real, just not ours. */
      accelDisplayOnly?: boolean;
      /** Maps to a macOS `PredefinedMenuItem`. Those carry real AppKit behaviour (a working Edit
       *  menu, the standard fullscreen item), which is worth more than routing the click back
       *  through the webview. Ignored by the in-window bar, which uses `run`. */
      role?: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'fullscreen' | 'closeWindow';
      checked?: boolean;
      disabled?: boolean;
      run: () => void;
    }
  | { kind: 'separator' }
  | { kind: 'submenu'; id: string; label: string; items: MenuNode[] };

export interface MenuDef {
  id: string;
  label: string;
  items: MenuNode[];
}

export type MenuItemNode = Extract<MenuNode, { kind: 'item' }>;
/** An item that declares an accelerator. `Extract` cannot express this: `accel` is optional, so
 *  matching it against `string` yields `never`. */
export type AccelItemNode = MenuItemNode & { accel: string };

/** Every actionable leaf, flattened — the shortcut handler and the shortcuts sheet both want the
 *  items regardless of nesting, and neither cares about separators. */
export function flattenItems(menus: MenuDef[]): MenuItemNode[] {
  const out: MenuItemNode[] = [];
  const walk = (nodes: MenuNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'item') out.push(node);
      else if (node.kind === 'submenu') walk(node.items);
    }
  };
  walk(menus.flatMap((menu) => menu.items));
  return out;
}

/** Items that declare an accelerator, in menu order. */
export function accelItems(menus: MenuDef[]): AccelItemNode[] {
  return flattenItems(menus).filter((item): item is AccelItemNode => typeof item.accel === 'string');
}

// ── Native (muda) accelerator syntax ──────────────────────────────────────────
// muda names keys by physical code — `KeyN`, `Digit0`, `Equal` — not by character, and takes
// `CmdOrCtrl` for the primary modifier (muda-0.19.3/src/accelerator.rs). Translating here keeps the
// declarations in `useAppMenus` written the one way the web handler understands.

const NATIVE_KEYS: Record<string, string> = {
  '=': 'Equal',
  '-': 'Minus',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
};

function nativeKey(key: string): string {
  if (NATIVE_KEYS[key]) return NATIVE_KEYS[key]!;
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^f\d+$/.test(key)) return key.toUpperCase();
  return key.toUpperCase();
}

export function toNativeAccel(accel: string): string {
  const { key, mod, shift, alt } = parseAccel(accel);
  const parts: string[] = [];
  if (mod) parts.push('CmdOrCtrl');
  if (shift) parts.push('Shift');
  if (alt) parts.push('Alt');
  parts.push(nativeKey(key));
  return parts.join('+');
}
