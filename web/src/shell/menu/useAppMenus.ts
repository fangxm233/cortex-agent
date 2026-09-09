// input:  window providers, native actions and manual update checks
// output: shared menus with async update progress and disabled state
// pos:    Single definition of the desktop application menus
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVocab } from '@/i18n';
import { useToastOptional } from '@/design/Toast';
import { useSettings } from '@/features/settings/SettingsProvider';
import { useScheduleModal } from '@/features/schedule/ScheduleModalProvider';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from '@/features/workbench/SelectedSessionProvider';
import { DRAFT_SENTINEL } from '@/features/workbench/selected-session';
import { useDock } from '@/features/dock/DockProvider';
import { useSetTheme, useTheme } from '@/theme/ThemeProvider';
import { safeInvoke } from '@/lib/native-bridge';
import { isDesktopShell } from '@/lib/desktop-config';
import { openExternalUrl } from '@/lib/external-navigation';
import { useManualUpdateCheck } from '@/features/update/useManualUpdateCheck';
import { usePaneState } from '../PaneStateProvider';
import { useShellModals } from '../ShellModalsProvider';
import { useWindowActions, type WindowActions } from './useWindowActions';
import type { MenuDef, MenuNode } from './menu-model';

export const DOCS_URL = 'https://fangxm233.github.io/cortex-agent/';

// Every menu item is declared exactly once, here. The HTML menu bar (Windows / Linux), the global
// shortcut handler and the keyboard shortcuts sheet all read this model, and the macOS
// native menu is built from the same list on the Rust side by id.
//
// Clipboard note: `execCommand` still drives cut/copy/select-all inside the webview, but paste is
// blocked there, so it goes through `navigator.clipboard.readText` + an `insertText` command. If
// that turns out to be denied on WebView2 we fall back to tauri-plugin-clipboard-manager; on macOS
// the whole Edit block is native and never reaches this code.
function exec(command: string): void {
  try {
    document.execCommand(command);
  } catch {
    /* the focused element simply does not support it */
  }
}

async function pasteFromClipboard(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    document.execCommand('insertText', false, text);
  } catch {
    /* clipboard read denied — the Ctrl+V the webview handles natively still works */
  }
}

const separator: MenuNode = { kind: 'separator' };

export function useAppMenus(): { menus: MenuDef[]; windowActions: WindowActions } {
  const L = useVocab();
  const navigate = useNavigate();
  const toast = useToastOptional();
  const settings = useSettings();
  const scheduleModal = useScheduleModal();
  const modals = useShellModals();
  const panes = usePaneState();
  const dock = useDock();
  const theme = useTheme();
  const setTheme = useSetTheme();
  const { currentProjectId } = useCurrentProject();
  const { selectedSessionId, setSelectedSession } = useSelectedSession();
  const windowActions = useWindowActions();
  const native = isDesktopShell();
  const { busy: checkingUpdates, check: checkUpdates } = useManualUpdateCheck();

  const menus = useMemo<MenuDef[]>(() => {
    const realSession = selectedSessionId && selectedSessionId !== DRAFT_SENTINEL ? selectedSessionId : null;

    const file: MenuDef = {
      id: 'file',
      label: L.menuFile,
      items: [
        {
          kind: 'item', id: 'file.newSession', label: L.mFileNewSession, accel: 'mod+n',
          run: () => { setSelectedSession(DRAFT_SENTINEL); navigate('/workbench'); },
        },
        { kind: 'item', id: 'file.newProject', label: L.mFileNewProject, run: modals.openNewProject },
        {
          kind: 'item', id: 'file.newSchedule', label: L.mFileNewSchedule,
          run: () => scheduleModal.open(currentProjectId ? { projectId: currentProjectId } : undefined),
        },
        separator,
        { kind: 'item', id: 'file.settings', label: L.mFileSettings, accel: 'mod+,', run: settings.open },
        separator,
        {
          kind: 'item', id: 'file.disconnect', label: L.mFileDisconnect, disabled: !native,
          run: () => void safeInvoke('disconnect'),
        },
        {
          kind: 'item', id: 'file.quit', label: L.mFileQuit, accel: 'mod+q', disabled: !native,
          run: windowActions.close,
        },
      ],
    };

    const edit: MenuDef = {
      id: 'edit',
      label: L.menuEdit,
      items: [
        { kind: 'item', id: 'edit.undo', accelDisplayOnly: true, role: 'undo', label: L.mEditUndo, accel: 'mod+z', run: () => exec('undo') },
        { kind: 'item', id: 'edit.redo', accelDisplayOnly: true, role: 'redo', label: L.mEditRedo, accel: 'mod+shift+z', run: () => exec('redo') },
        separator,
        { kind: 'item', id: 'edit.cut', accelDisplayOnly: true, role: 'cut', label: L.mEditCut, accel: 'mod+x', run: () => exec('cut') },
        { kind: 'item', id: 'edit.copy', accelDisplayOnly: true, role: 'copy', label: L.mEditCopy, accel: 'mod+c', run: () => exec('copy') },
        { kind: 'item', id: 'edit.paste', accelDisplayOnly: true, role: 'paste', label: L.mEditPaste, accel: 'mod+v', run: () => void pasteFromClipboard() },
        { kind: 'item', id: 'edit.selectAll', accelDisplayOnly: true, role: 'selectAll', label: L.mEditSelectAll, accel: 'mod+a', run: () => exec('selectAll') },
        separator,
        {
          kind: 'item', id: 'edit.palette', accelDisplayOnly: true, label: L.mEditPalette, accel: 'mod+k',
          // The palette's open state lives in AppShell's own `useCommandPalette` instance, so the
          // established way to reach it from elsewhere is the synthetic key event (precedent:
          // features/workbench/CenterChat.tsx).
          run: () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true })),
        },
        {
          kind: 'item', id: 'edit.copySessionId', label: L.mEditCopySessionId, disabled: !realSession,
          run: () => {
            if (!realSession) return;
            void navigator.clipboard?.writeText(realSession).catch(() => {});
            toast?.toast({ title: L.mEditCopySessionId, tone: 'done' });
          },
        },
      ],
    };

    const view: MenuDef = {
      id: 'view',
      label: L.menuView,
      items: [
        {
          kind: 'item', id: 'view.leftRail', label: L.mViewLeftRail, accel: 'mod+b',
          checked: !panes.railCollapsed, run: panes.toggleRail,
        },
        {
          kind: 'item', id: 'view.rightPanel', label: L.mViewRightPanel, accel: 'mod+alt+b',
          checked: !panes.panelCollapsed, run: panes.togglePanel,
        },
        {
          kind: 'item', id: 'view.dock', label: L.mViewDock, accel: 'mod+j',
          checked: dock.open, disabled: !dock.canDock, run: dock.toggleDock,
        },
        separator,
        { kind: 'item', id: 'view.workbench', label: L.mViewWorkbench, run: () => navigate('/workbench') },
        { kind: 'item', id: 'view.overview', label: L.mViewOverview, run: () => navigate('/overview') },
        { kind: 'item', id: 'view.memory', label: L.mViewMemory, run: () => navigate('/memory') },
        separator,
        {
          kind: 'submenu', id: 'view.appearance', label: L.mViewAppearance,
          items: [
            { kind: 'item', id: 'view.theme.light', label: L.mViewThemeLight, checked: theme === 'light', run: () => setTheme('light') },
            { kind: 'item', id: 'view.theme.dark', label: L.mViewThemeDark, checked: theme === 'dark', run: () => setTheme('dark') },
            // `'system'` has always been a valid theme value; no desktop control ever exposed it.
            { kind: 'item', id: 'view.theme.system', label: L.mViewThemeSystem, checked: theme === 'system', run: () => setTheme('system') },
          ],
        },
        separator,
        { kind: 'item', id: 'view.zoomIn', label: L.mViewZoomIn, accel: 'mod+=', disabled: !native, run: windowActions.zoomIn },
        { kind: 'item', id: 'view.zoomOut', label: L.mViewZoomOut, accel: 'mod+-', disabled: !native, run: windowActions.zoomOut },
        { kind: 'item', id: 'view.zoomReset', label: L.mViewZoomReset, accel: 'mod+0', disabled: !native, run: windowActions.zoomReset },
        separator,
        { kind: 'item', id: 'view.fullscreen', role: 'fullscreen', label: windowActions.isFullscreen ? L.windowExitFullscreen : L.mViewFullScreen, checked: windowActions.isFullscreen, accel: 'f11', disabled: !native, run: windowActions.toggleFullscreen },
      ],
    };

    const help: MenuDef = {
      id: 'help',
      label: L.menuHelp,
      items: [
        { kind: 'item', id: 'help.docs', label: L.mHelpDocs, run: () => void openExternalUrl(DOCS_URL).catch(() => {}) },
        separator,
        { kind: 'item', id: 'help.daemon', label: L.mHelpDaemon, run: modals.openDaemonStatus },
        {
          kind: 'item', id: 'help.updates', label: checkingUpdates ? L.updateCheckBusy : L.mHelpUpdates,
          disabled: !native || checkingUpdates, run: () => void checkUpdates(),
        },
        { kind: 'item', id: 'help.devtools', label: L.mHelpDevTools, disabled: !native, run: windowActions.toggleDevTools },
        separator,
        { kind: 'item', id: 'help.about', label: L.mHelpAbout, run: modals.openAbout },
      ],
    };

    return [file, edit, view, help];
  }, [L, navigate, toast, settings, scheduleModal, modals, panes, dock, theme, setTheme,
    currentProjectId, selectedSessionId, setSelectedSession, windowActions, native, checkingUpdates, checkUpdates]);

  return { menus, windowActions };
}
