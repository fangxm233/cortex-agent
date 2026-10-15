import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Providers } from '@/providers';
import { RootRouter } from '@/RootRouter';
import { isConnectScreen } from '@/lib/shell-connection';
import { ShellOnboarding } from '@/features/provider-setup/ShellOnboarding';
import { ShellUninstall, isUninstallScreen } from '@/features/uninstall/ShellUninstall';
import '@/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element not found');
}

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
    <Root />
  </StrictMode>,
);
