// input:  pane state, app menus, connection status, theme, settings sections
// output: TopBar, TOP_BAR_HEIGHT
// pos:    Responsive window chrome with all actions retained and a direct Usage entry
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useState, type CSSProperties, type ReactNode } from 'react';
import './top-bar.css';
import { useVocab } from '@/i18n';
import { captionInsetLeft, titleBarMode, usesCommandKey } from '@/lib/desktop-platform';
import { useTheme, useSetTheme } from '@/theme';
import { useSettings } from '@/features/settings/SettingsProvider';
import { getSettingsNavIcon } from '@/features/settings/settings-nav';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { connectionDot, connectionLabelKey } from '@/features/connection/connection-status';
import { BrandBadge, GearIcon } from '@/features/workbench/LeftRail';
import { usePaneState } from './PaneStateProvider';
import { useNavigationHistory } from './NavigationHistoryProvider';
import { useShellModals } from './ShellModalsProvider';
import { MenuBar } from './menu/MenuBar';
import { formatAccel } from './menu/menu-model';
import { useAppMenus } from './menu/useAppMenus';
import { useMenuShortcuts } from './menu/useMenuShortcuts';
import { useNativeMenu } from './menu/useNativeMenu';
import { WindowControls } from './WindowControls';

export const TOP_BAR_HEIGHT = 44;

const mono = "'IBM Plex Mono',monospace";

// The bar is the app's one always-visible surface, so everything that must survive a collapsed rail
// lives here: the brand block with its connectivity dot, the palette entry, theme, Usage and Settings.
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
  const tone = disabled ? 'var(--proto-line-3)' : active || hover ? 'var(--proto-ink)' : 'var(--proto-muted)';
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
        borderRadius: 'var(--r-chip)',
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

// Same glyph as the Usage row in the settings nav, so the key and the page it opens read as one thing.
// Drawn at the gear's size: the two sit side by side and share a full-bleed 24px frame.
function UsageGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" {...strokeProps}>
      <path d={getSettingsNavIcon('usage')} />
    </svg>
  );
}

function SearchGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <circle cx="7.2" cy="7.2" r="3.9" />
      <path d="M10.1 10.1 12.9 12.9" />
    </svg>
  );
}

// The palette entry. A real button, not a styled div: it has to be keyboard reachable, and Tauri's
// drag walk stops at the first clickable ancestor — a div here would drag the window instead.
function CommandPill({ label, accel, onClick }: { label: string; accel: string; onClick: () => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} (${accel})`}
      className="shell-command-pill"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 30,
        minWidth: 34,
        maxWidth: 320,
        padding: '0 10px',
        boxSizing: 'border-box',
        border: 0,
        borderRadius: 'var(--r-pill)',
        background: hover ? 'var(--glass-2)' : 'var(--glass-1)',
        backdropFilter: 'var(--glass-filter)',
        WebkitBackdropFilter: 'var(--glass-filter)',
        boxShadow: '0 0 0 1px var(--proto-line)',
        color: hover ? 'var(--proto-ink)' : 'var(--proto-muted)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        // A button centres its text; the pill reads as a field, so its placeholder starts at the left.
        textAlign: 'left',
        flex: '0 1 320px',
        overflow: 'hidden',
      }}
    >
      <SearchGlyph />
      <span className="shell-command-label" style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span className="shell-command-accel" style={{ font: `500 11px ${mono}`, color: 'var(--proto-muted)', flex: 'none' }}>{accel}</span>
    </button>
  );
}

export function TopBar(): JSX.Element {
  const L = useVocab();
  const panes = usePaneState();
  const history = useNavigationHistory();
  const theme = useTheme();
  const setTheme = useSetTheme();
  const { open: openSettings, openSection: openSettingsSection } = useSettings();
  // Live UI↔server connectivity for the brand badge (green connected / amber (re)connecting /
  // red disconnected).
  const connStatus = useConnectionStatus();
  const connDot = connectionDot(connStatus);
  const connLabel = L[connectionLabelKey(connStatus)];
  const shellModals = useShellModals();
  const { menus, windowActions } = useAppMenus();
  // On macOS the shell installs a real system menu and owns the accelerators; everywhere else this
  // reports inactive and the bar draws the menus itself.
  const nativeMenu = useNativeMenu(menus);
  useMenuShortcuts(menus, !nativeMenu.active);

  const mode = titleBarMode();
  const style: CSSProperties = {
    height: TOP_BAR_HEIGHT,
    boxSizing: 'border-box',
    flex: 'none',
    display: windowActions.isFullscreen ? 'none' : 'flex',
    alignItems: 'center',
    // Transparent on purpose: the bar is a strip of the mesh ground, not a panel. Its buttons are
    // the only marks on it, so the panes below read as floating rather than as a docked layout with
    // a header. Nothing here needs a divider — the gap under the bar does that job.
    background: 'transparent',
  };

  return (
    // `deep` makes the whole bar draggable, and Tauri's injected script stops the walk at the first
    // clickable ancestor — buttons and role="menuitem" rows block the drag before it reaches here
    // (tauri/src/window/scripts/drag.js). Without `deep`, only direct hits on the bar element would
    // drag and every gap inside a wrapper div would be a dead zone.
    <div style={style} data-app-topbar data-tauri-drag-region="deep">
      {/* macOS keeps its native traffic lights under TitleBarStyle::Overlay; reserve their strip. */}
      <div style={{ width: captionInsetLeft(), flex: 'none' }} />

      {/* The bar itself is full-bleed, so the gutter is on the first and last CONTENT clusters —
          that is what lines the brand mark up with the rail below it. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          flex: 'none',
          paddingLeft: mode === 'overlay' ? 0 : 'var(--app-gutter)',
          paddingRight: 10,
        }}
      >
        <BrandBadge
          dot={connDot}
          label={`${L.dmDaemon} · ${connLabel}`}
          onClick={() => shellModals.openDaemonStatus()}
        />
        <div className="shell-brand-label" style={{ fontWeight: 650, fontSize: 14, color: 'var(--proto-ink)', letterSpacing: '-.01em' }}>Cortex</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}>
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
        <div style={{ marginLeft: 10, flex: 'none' }}>
          <MenuBar menus={menus} />
        </div>
      )}

      <div className="shell-topbar-spacer" />

      <CommandPill
        label={L.cmdkPh}
        accel={formatAccel('mod+k', usesCommandKey())}
        // The palette's open state lives in AppShell's own `useCommandPalette` instance, so the
        // established way to reach it from elsewhere is the synthetic key event (precedent:
        // shell/menu/useAppMenus.ts, features/workbench/CenterChat.tsx).
        onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }))}
      />

      <div className="shell-topbar-spacer" />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none', paddingRight: 'var(--app-gutter)' }}>
        {/* Theme controls remain keyboard reachable when labels compact. The capsule also opts
            out of the native drag region so its gaps cannot begin a window drag. */}
        <div
          data-tauri-drag-region="false"
          style={{
            display: 'flex',
            borderRadius: 'var(--r-chip)',
            overflow: 'hidden',
            background: 'var(--glass-1)',
            boxShadow: '0 0 0 1px var(--proto-line)',
          }}
        >
          <button
            type="button"
            aria-pressed={theme === 'light'}
            onClick={() => setTheme('light')}
            title={L.stThemeLight}
            aria-label={L.stThemeLight}
            style={{ border: 0, fontFamily: 'inherit', fontSize: 11, fontWeight: 600, padding: '5px 9px', cursor: 'pointer', background: theme === 'light' ? 'var(--ink-solid-bg)' : 'transparent', color: theme === 'light' ? 'var(--ink-solid-fg)' : 'var(--proto-muted)' }}
          >
            ☀
          </button>
          <button
            type="button"
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme('dark')}
            title={L.stThemeDark}
            aria-label={L.stThemeDark}
            style={{ border: 0, fontFamily: 'inherit', fontSize: 11, fontWeight: 600, padding: '5px 9px', cursor: 'pointer', background: theme === 'dark' ? 'var(--ink-solid-bg)' : 'transparent', color: theme === 'dark' ? 'var(--ink-solid-fg)' : 'var(--proto-muted)' }}
          >
            ☾
          </button>
        </div>
        {/* Usage is checked far more often than anything else in Settings, so it gets its own key
            that opens the sheet already on that page. */}
        <IconButton label={L.stNavUsage} onClick={() => openSettingsSection('usage')}>
          <UsageGlyph />
        </IconButton>
        {/* Settings is a gear key, not a word: a label here made the cluster read as competing texts. */}
        <IconButton label={L.settings} onClick={openSettings}>
          <GearIcon />
        </IconButton>
      </div>

      {mode === 'custom' && <WindowControls actions={windowActions} />}
    </div>
  );
}
