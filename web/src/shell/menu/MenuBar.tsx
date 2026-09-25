// input:  menu-model, desktop platform
// output: MenuBar
// pos:    Compact app menus and readable shortcut hints
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useEffect, useRef, useState } from 'react';
import { usesCommandKey } from '@/lib/desktop-platform';
import { formatAccel, type MenuDef, type MenuNode } from './menu-model';

const MONO = "'IBM Plex Mono',monospace";
const BAR_ITEM_HEIGHT = 30;

// Classic menu-bar behaviour: the first click opens a menu and arms the bar, after which merely
// hovering a sibling title switches to it. Closing disarms. Radix has no menubar primitive in this
// codebase, and the existing dropdown precedent (ChatHeader's ⋯) is a single hand-rolled popover,
// so this follows the same shape — local state, Escape and a document click to dismiss.

function ItemRow({ node, onRun }: { node: MenuNode; onRun: () => void }): JSX.Element | null {
  const commandKey = usesCommandKey();
  const [hover, setHover] = useState(false);
  const [subOpen, setSubOpen] = useState(false);

  if (node.kind === 'separator') {
    return <div style={{ height: 1, background: 'var(--proto-line)', margin: '5px 8px' }} />;
  }

  if (node.kind === 'submenu') {
    return (
      <div
        style={{ position: 'relative' }}
        onMouseEnter={() => setSubOpen(true)}
        onMouseLeave={() => setSubOpen(false)}
      >
        <div style={rowStyle(subOpen, false)}>
          <span style={{ width: 14 }} />
          <span>{node.label}</span>
          <span style={{ marginLeft: 'auto', color: 'var(--proto-muted-3)' }}>›</span>
        </div>
        {subOpen && (
          <div style={{ ...submenuStyle, position: 'absolute', left: '100%', top: -5, minWidth: 168 }}>
            {node.items.map((child, index) => (
              <ItemRow key={child.kind === 'item' ? child.id : `sep-${index}`} node={child} onRun={onRun} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="menuitem"
      aria-disabled={node.disabled || undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(event) => {
        event.stopPropagation();
        if (node.disabled) return;
        node.run();
        onRun();
      }}
      style={rowStyle(hover && !node.disabled, !!node.disabled)}
    >
      <span style={{ width: 14, textAlign: 'center', color: 'inherit' }}>{node.checked ? '✓' : ''}</span>
      <span>{node.label}</span>
      {node.accel && (
        <span style={{ marginLeft: 'auto', font: `500 11px ${MONO}`, color: hover && !node.disabled ? 'inherit' : 'var(--proto-muted)' }}>
          {formatAccel(node.accel, commandKey)}
        </span>
      )}
    </div>
  );
}

function rowStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: 27,
    padding: '0 9px',
    borderRadius: 'var(--r-chip)',
    fontSize: 12.5,
    whiteSpace: 'nowrap',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? 'var(--proto-line-3)' : active ? 'var(--ink-solid-fg)' : 'var(--proto-ink)',
    background: active ? 'var(--proto-accent)' : 'transparent',
  };
}

const panelBase: React.CSSProperties = {
  borderRadius: 'var(--r-float)',
  boxShadow: 'var(--shadow-menu-strong), 0 0 0 1px var(--proto-line-2)',
  padding: 5,
  minWidth: 238,
  zIndex: 60,
};

// A floating glass sheet, like `design/Popover`: `--glass-2` over its own backdrop filter, with the
// hairline ring carried by the shadow so the panel keeps its exact geometry over the blur. Unlike
// `MenuChrome`'s opaque panel this one never scrolls, so the backdrop is sampled once per open.
const panelStyle: React.CSSProperties = {
  ...panelBase,
  background: 'var(--glass-2)',
  backdropFilter: 'var(--glass-filter)',
  WebkitBackdropFilter: 'var(--glass-filter)',
};

// A submenu opens beside its parent, i.e. outside the parent's painted box but still inside the
// backdrop root that parent's filter creates — so its own `backdrop-filter` would sample nothing
// and leave bare translucency over live text. It stays opaque instead, like `MenuChrome`.
const submenuStyle: React.CSSProperties = { ...panelBase, background: 'var(--proto-card)' };

export function MenuBar({ menus }: { menus: MenuDef[] }): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openId) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenId(null); };
    const onClick = () => setOpenId(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [openId]);

  return (
    <div ref={barRef} style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}>
      {menus.map((menu) => {
        const open = openId === menu.id;
        return (
          <div key={menu.id} style={{ position: 'relative' }}>
            <button
              type="button"
              className="shell-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={(event) => {
                event.stopPropagation();
                setOpenId(open ? null : menu.id);
              }}
              onMouseEnter={() => { if (openId) setOpenId(menu.id); }}
              style={{
                height: BAR_ITEM_HEIGHT,
                border: 0,
                borderRadius: 'var(--r-chip)',
                fontFamily: 'inherit',
                fontSize: 13,
                cursor: 'pointer',
                background: open ? 'var(--proto-line-2)' : 'transparent',
                color: open ? 'var(--proto-ink)' : 'var(--proto-muted)',
              }}
            >
              {menu.label}
            </button>
            {open && (
              <div
                role="menu"
                onClick={(event) => event.stopPropagation()}
                // Separators and submenu rows are not clickable elements, so without this the bar's
                // `deep` drag region would swallow clicks on them and move the window instead.
                data-tauri-drag-region="false"
                style={{ ...panelStyle, position: 'absolute', left: 0, top: BAR_ITEM_HEIGHT + 10 }}
              >
                {menu.items.map((node, index) => (
                  <ItemRow
                    key={node.kind === 'item' ? node.id : node.kind === 'submenu' ? node.id : `sep-${index}`}
                    node={node}
                    onRun={() => setOpenId(null)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
