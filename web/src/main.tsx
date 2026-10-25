import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Providers } from '@/providers';
import { RootRouter } from '@/RootRouter';
import { isConnectScreen } from '@/lib/shell-connection';
import { ShellOnboarding } from '@/features/provider-setup/ShellOnboarding';
import { ShellUninstall, isUninstallScreen } from '@/features/uninstall/ShellUninstall';
import { installGlobalErrorCapture } from '@/features/telemetry/crash-capture';
import { telemetryQueue } from '@/features/telemetry/report-queue';
import { RootErrorBoundary } from '@/features/telemetry/RootErrorBoundary';
import '@/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element not found');
}

// Before the first render, so a crash during it is still reported. The connect and uninstall
// screens have no server to report to, so nothing they raise is kept.
installGlobalErrorCapture();
if (isUninstallScreen() || isConnectScreen()) telemetryQueue.disable();

// RootRouter picks the mobile vs desktop router by viewport (inside Providers → LangProvider). The
// native shell's connect screen has no server yet, and its uninstaller needs none, so both render
// outside the server providers.
function Root() {
  if (isUninstallScreen()) return <ShellUninstall />;
  if (isConnectScreen()) return <ShellOnboarding />;
  return <Providers><RootRouter /></Providers>;
}

createRoot(rootEl).render(
  <StrictMode>
    <RootErrorBoundary>
      <Root />
    </RootErrorBoundary>
  </StrictMode>,
);
