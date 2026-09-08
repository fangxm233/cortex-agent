// input:  the assembled menu model and the native bridge
// output: the macOS system menu bar, kept in sync, and its click routing
// pos:    Bridges one menu model to the platform's real menu
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useEffect, useMemo, useRef, useState } from 'react';
import { listenNativeEvent, safeInvoke } from '@/lib/native-bridge';
import { flattenItems, toNativeAccel, type MenuDef, type MenuNode } from './menu-model';

// The SPA sends the tree; the shell turns it into a real `tauri::menu::Menu` (desktop/src-tauri/
// src/native_menu.rs). Doing it this way rather than hard-coding the menu in Rust means the labels
// are already translated and the check marks are already resolved — a language switch or a toggle
// is just another push, with no second definition to keep in step.
//
// The shell answers `false` on Windows and Linux, which is how the caller learns it still has to
// draw the bar itself.

interface NativeNode {
  kind: MenuNode['kind'];
  id?: string;
  label?: string;
  accelerator?: string;
  role?: string;
  checked?: boolean;
  enabled?: boolean;
  items?: NativeNode[];
}

function toNative(node: MenuNode): NativeNode {
  if (node.kind === 'separator') return { kind: 'separator' };
  if (node.kind === 'submenu') {
    return { kind: 'submenu', id: node.id, label: node.label, items: node.items.map(toNative) };
  }
  return {
    kind: 'item',
    id: node.id,
    label: node.label,
    accelerator: node.accel ? toNativeAccel(node.accel) : undefined,
    role: node.role,
    checked: node.checked,
    enabled: node.disabled ? false : true,
  };
}

export interface NativeMenuState {
  /** True once the shell confirms it installed a real menu — the in-window bar must then not draw
   *  File/Edit/View/Help, and the web accelerator handler must stand down (the native menu owns
   *  the keys, and binding them twice would double-fire). */
  active: boolean;
}

export function useNativeMenu(menus: MenuDef[]): NativeMenuState {
  const [active, setActive] = useState(false);
  const menusRef = useRef(menus);
  menusRef.current = menus;

  const spec = useMemo(
    () => ({ menus: menus.map((menu) => ({ kind: 'submenu' as const, id: menu.id, label: menu.label, items: menu.items.map(toNative) })) }),
    [menus],
  );
  // Rebuilding the whole menu is the update mechanism, so push only when the tree actually differs.
  // `useAppMenus` returns a new object on every render; without this the shell would rebuild the
  // macOS menu on each keystroke.
  const serialized = useMemo(() => JSON.stringify(spec), [spec]);

  useEffect(() => {
    let alive = true;
    void safeInvoke('set_native_menu', { spec: JSON.parse(serialized) }).then((result) => {
      if (alive && result.ok) setActive(result.value);
    });
    return () => { alive = false; };
  }, [serialized]);

  // A native click carries only the item id; look it up in the same model and run the same handler
  // the in-window bar would have.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void listenNativeEvent('native-menu', (payload) => {
      if (typeof payload !== 'string') return;
      const item = flattenItems(menusRef.current).find((candidate) => candidate.id === payload);
      if (item && !item.disabled) item.run();
    }).then((off) => {
      unsubscribe = off;
    });
    return () => unsubscribe?.();
  }, []);

  return { active };
}
