// input:  pane state, the navigation stack, the app menus and the window chrome mode
// output: the 50px application bar: sidebar toggle, history arrows, menus, drag region, caption
// pos:    The window's single top bar, above the pane row
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useVocab } from '@/i18n';
import { captionInsetLeft, titleBarMode } from '@/lib/desktop-platform';
import { usePaneState } from './PaneStateProvider';
import { useNavigationHistory } from './NavigationHistoryProvider';
import { MenuBar } from './menu/MenuBar';
import { useAppMenus } from './menu/useAppMenus';
import { useMenuShortcuts } from './menu/useMenuShortcuts';
import { useNativeMenu } from './menu/useNativeMenu';
import { WindowControls } from './WindowControls';

export const TOP_BAR_HEIGHT = 50;

// Left-loaded by design: the right side is nothing but drag region and caption buttons. An earlier
// draft put live status chips there; they were dropped so the bar stays a command surface.
//
// Everything here is window-scoped. Session-scoped controls (Browser, Notes, ⋯) stay in ChatHeader.

function IconButton({ label, active, disabled, onClick, children }: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  const tone = disabled ? 'var(--proto-line-3)' : active || hover ? 'var(--proto-ink)' : 'var(--proto-muted-2)';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 30,
        height: 30,
        border: 0,
        borderRadius: 7,
        padding: 0,
        display: 'grid',
        placeItems: 'center',
        cursor: disabled ? 'default' : 'pointer',
        color: tone,
        background: active && !disabled ? 'var(--proto-line-2)' : 'transparent',
        flex: 'none',
      }}
    >
      {children}
    </button>
  );
}

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function PanelGlyph(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" {...strokeProps}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1="9.5" y1="4" x2="9.5" y2="20" />
    </svg>
  );
}

function ArrowGlyph({ forward }: { forward?: boolean }): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" {...strokeProps}>
      <path d={forward ? 'M5 12h14M13 6l6 6-6 6' : 'M19 12H5M11 6l-6 6 6 6'} />
    </svg>
  );
}

export function TopBar(): JSX.Element {
  const L = useVocab();
  const panes = usePaneState();
  const history = useNavigationHistory();
  const { menus, windowActions } = useAppMenus();
  // On macOS the shell installs a real system menu and owns the accelerators; everywhere else this
  // reports inactive and the bar draws the menus itself.
  const nativeMenu = useNativeMenu(menus);
  useMenuShortcuts(menus, !nativeMenu.active);

  const mode = titleBarMode();
  const style: CSSProperties = {
    height: TOP_BAR_HEIGHT,
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    background: 'var(--proto-rail)',
    borderBottom: '1px solid var(--proto-line)',
  };

  return (
    // `deep` makes the whole bar draggable, and Tauri's injected script stops the walk at the first
    // clickable ancestor — buttons and role="menuitem" rows block the drag before it reaches here
    // (tauri/src/window/scripts/drag.js). Without `deep`, only direct hits on the bar element would
    // drag and every gap inside a wrapper div would be a dead zone.
    <div style={style} data-tauri-drag-region="deep">
      {/* macOS keeps its native traffic lights under TitleBarStyle::Overlay; reserve their strip. */}
      <div style={{ width: captionInsetLeft(), flex: 'none' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none', paddingLeft: mode === 'overlay' ? 0 : 12 }}>
        <IconButton label={L.tbToggleRail} active={!panes.railCollapsed} onClick={panes.toggleRail}>
          <PanelGlyph />
        </IconButton>
        <IconButton label={L.tbBack} disabled={!history.canBack} onClick={history.back}>
          <ArrowGlyph />
        </IconButton>
        <IconButton label={L.tbForward} disabled={!history.canForward} onClick={history.forward}>
          <ArrowGlyph forward />
        </IconButton>
      </div>

      {!nativeMenu.active && (
        <div style={{ marginLeft: 14, flex: 'none' }}>
          <MenuBar menus={menus} />
        </div>
      )}

      <div style={{ flex: 1, alignSelf: 'stretch', minWidth: 20 }} />

      {mode === 'custom' && <WindowControls actions={windowActions} />}
    </div>
  );
}
