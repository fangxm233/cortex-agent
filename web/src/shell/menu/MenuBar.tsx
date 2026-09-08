// input:  the app menu model and the platform's primary modifier
// output: the in-window File / Edit / View / Help bar with its dropdowns
// pos:    Windows and Linux menu bar inside the app-drawn title bar
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
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
          <div style={{ ...panelStyle, position: 'absolute', left: '100%', top: -5, minWidth: 168 }}>
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
        <span style={{ marginLeft: 'auto', font: `500 10px ${MONO}`, opacity: hover && !node.disabled ? 0.8 : 1, color: hover && !node.disabled ? 'inherit' : 'var(--proto-muted-3)' }}>
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
    borderRadius: 6,
    fontSize: 12.5,
    whiteSpace: 'nowrap',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? 'var(--proto-line-3)' : active ? 'var(--ink-solid-fg)' : 'var(--proto-ink)',
    background: active ? 'var(--proto-accent)' : 'transparent',
  };
}

const panelStyle: React.CSSProperties = {
  background: 'var(--proto-card)',
  border: '1px solid var(--proto-line)',
  borderRadius: 10,
  boxShadow: 'var(--shadow-menu-strong)',
  padding: 5,
  minWidth: 238,
  zIndex: 60,
};

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
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={(event) => {
                event.stopPropagation();
                setOpenId(open ? null : menu.id);
              }}
              onMouseEnter={() => { if (openId) setOpenId(menu.id); }}
              style={{
                height: BAR_ITEM_HEIGHT,
                padding: '0 11px',
                border: 0,
                borderRadius: 7,
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
