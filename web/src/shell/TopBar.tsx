import { useState, type CSSProperties } from 'react';
import './top-bar.css';
import { useVocab } from '@/i18n';
import { captionInsetLeft, titleBarMode, usesCommandKey } from '@/lib/desktop-platform';
import { useSettings } from '@/features/settings/useSettings';
import { getSettingsNavIcon } from '@/features/settings/settings-nav';
import { MachinesMenu } from '@/features/machines/MachinesMenu';
import { useConnectionStatus } from '@/features/connection/ConnectionStatusProvider';
import { connectionDot, connectionLabelKey } from '@/features/connection/connection-status';
import { BrandBadge } from '@/features/workbench/rail/LeftRail';
import { toggleRail, useRailCollapsed } from '@/features/workbench/rail/rail-collapsed';
import { useDaemonStatusModal } from '@/features/daemon/useDaemonStatusModal';
import { useNavigationHistory } from './NavigationHistoryProvider';
import { MenuBar } from './menu/MenuBar';
import { formatAccel } from './menu/menu-model';
import { useAppMenus } from './menu/useAppMenus';
import { useMenuShortcuts } from './menu/useMenuShortcuts';
import { useNativeMenu } from './menu/useNativeMenu';
import { WindowControls } from '@/design/WindowControls';
import { IconButton } from '@/design/IconButton';

export const TOP_BAR_HEIGHT = 44;

// The bar is the app's one always-visible surface, so everything that must survive a collapsed rail
// lives here: the brand block with its connectivity dot, the palette entry, the machines menu, Usage
// and Settings. Theme is not a key here: it is set rarely, and View → Appearance (and Settings) hold
// Light / Dark / System, so the bar's right side stays three icon keys.
//
// Everything here is window-scoped. Session-scoped controls (Browser, Notes, ⋯) stay in ChatHeader.

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

// The right-hand keys draw at 17px on a lighter stroke: they are the bar's only marks on that side,
// so they carry a little more size than the navigation arrows without reading heavier.
const toolStrokeProps = { ...strokeProps, strokeWidth: 1.7 } as const;

// Same glyph as the Usage row in the settings nav, so the key and the page it opens read as one thing.
// Drawn at the gear's size: the two sit side by side and share a full-bleed 24px frame.
function UsageGlyph(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" {...toolStrokeProps}>
      <path d={getSettingsNavIcon('usage')} />
    </svg>
  );
}

// A toothed cog, not a ring of short strokes: at this size the latter reads as a sun.
function SettingsGlyph(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" {...toolStrokeProps}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
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
      <span className="shell-command-accel" style={{ font: '400 11.5px var(--font-ui)', color: 'var(--proto-faint)', flex: 'none' }}>{accel}</span>
    </button>
  );
}

export function TopBar(): JSX.Element {
  const L = useVocab();
  const railCollapsed = useRailCollapsed();
  const history = useNavigationHistory();
  const { open: openSettings, openSection: openSettingsSection } = useSettings();
  // Live UI↔server connectivity for the brand badge (green connected / amber (re)connecting /
  // red disconnected).
  const connStatus = useConnectionStatus();
  const connDot = connectionDot(connStatus);
  const connLabel = L[connectionLabelKey(connStatus)];
  const daemonStatus = useDaemonStatusModal();
  const { menus, windowActions } = useAppMenus();
  // On macOS the shell installs a real system menu and owns the accelerators; everywhere else this
  // reports inactive and the bar draws the menus itself.
  const nativeMenu = useNativeMenu(menus);
  useMenuShortcuts(menus, !nativeMenu.active);

  const commandKey = usesCommandKey();
  const mode = titleBarMode();
  // Full screen keeps the bar. The traffic lights hide there, so their strip goes, and the window
  // drag and caption buttons have nothing to act on.
  const fullscreen = windowActions.isFullscreen;
  const insetLeft = fullscreen ? 0 : captionInsetLeft();
  const style: CSSProperties = {
    height: TOP_BAR_HEIGHT,
    boxSizing: 'border-box',
    flex: 'none',
    display: 'flex',
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
    <div style={style} data-app-topbar data-tauri-drag-region={fullscreen ? undefined : 'deep'}>
      {/* macOS keeps its native traffic lights under TitleBarStyle::Overlay; reserve their strip. */}
      <div style={{ width: insetLeft, flex: 'none' }} />

      {/* The bar itself is full-bleed, so the gutter is on the first and last CONTENT clusters —
          that is what lines the brand mark up with the rail below it. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          flex: 'none',
          paddingLeft: insetLeft ? 0 : 'var(--app-gutter)',
          paddingRight: 10,
        }}
      >
        <BrandBadge
          dot={connDot}
          label={`${L.dmDaemon} · ${connLabel}`}
          onClick={() => daemonStatus.open()}
        />
        <div className="shell-brand-label" style={{ fontWeight: 650, fontSize: 14, color: 'var(--proto-ink)', letterSpacing: '-.01em' }}>Cortex</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}>
        <IconButton label={L.tbToggleRail} active={!railCollapsed} onClick={toggleRail}>
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
        accel={formatAccel('mod+k', commandKey)}
        // The palette's open state lives in AppShell's own `useCommandPalette` instance, so the
        // established way to reach it from elsewhere is the synthetic key event (precedent:
        // shell/menu/useAppMenus.ts, features/workbench/chat/CenterChat.tsx).
        onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }))}
      />

      <div className="shell-topbar-spacer" />

      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none', paddingRight: 'var(--app-gutter)' }}>
        <MachinesMenu onManage={() => openSettingsSection('machines')} />
        {/* Usage is checked far more often than anything else in Settings, so it gets its own key
            that opens the sheet already on that page. */}
        <IconButton size={32} label={L.stNavUsage} onClick={() => openSettingsSection('usage')}>
          <UsageGlyph />
        </IconButton>
        {/* Settings is a gear key, not a word: a label here made the cluster read as competing texts.
            Its File-menu shortcut rides in the tooltip, the one place a key can show it. */}
        <IconButton
          size={32}
          label={L.settings}
          title={`${L.settings} (${formatAccel('mod+,', commandKey)})`}
          onClick={openSettings}
        >
          <SettingsGlyph />
        </IconButton>
      </div>

      {mode === 'custom' && !fullscreen && <WindowControls actions={windowActions} />}
    </div>
  );
}
