import { LangProvider, useVocab } from '@/i18n';
import { ThemeProvider } from '@/theme';
import { isDesktopShell } from '@/lib/desktop-config';
import { invokeNative } from '@/lib/native-bridge';
import { SetupHeader } from '@/features/provider-setup/SetupHeader';
import { UninstallScreen } from './UninstallScreen';
import type { UninstallPorts } from './uninstall-flow';
import '@/features/provider-setup/provider-setup.css';
import '@/features/provider-setup/onboarding.css';
import './uninstall.css';

/** The document the shell opens when started as `cortex-desktop --uninstall`. */
export const UNINSTALL_SCREEN_PATH = 'uninstall.html';

export function isUninstallScreen(): boolean {
  return isDesktopShell() && globalThis.location?.pathname.endsWith(`/${UNINSTALL_SCREEN_PATH}`) === true;
}

const nativePorts: UninstallPorts = {
  info: () => invokeNative('uninstall_info'),
  run: (scope, deleteData) => invokeNative('uninstall_run', { scope, deleteData }),
  exit: proceed => invokeNative('uninstall_exit', { proceed }),
};

function Frame() {
  const L = useVocab();
  return <div className="provider-setup">
    <SetupHeader label={L.uninstHeader} />
    <div className="setup-scroll"><main className="setup-workspace onb"><UninstallScreen ports={nativePorts} /></main></div>
  </div>;
}

/** Like the connect screen, the uninstaller has no server: it renders without the tRPC providers. */
export function ShellUninstall() {
  return <ThemeProvider><LangProvider><Frame /></LangProvider></ThemeProvider>;
}
