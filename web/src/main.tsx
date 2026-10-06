import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Providers } from '@/providers';
import { RootRouter } from '@/RootRouter';
import { isConnectScreen } from '@/lib/shell-connection';
import { ShellOnboarding } from '@/features/provider-setup/ShellOnboarding';
import '@/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element not found');
}

// RootRouter picks the mobile vs desktop router by viewport (inside Providers → LangProvider). The
// native shell's connect screen has no server yet, so it renders outside the server providers.
createRoot(rootEl).render(
  <StrictMode>
    {isConnectScreen() ? <ShellOnboarding /> : (
      <Providers>
        <RootRouter />
      </Providers>
    )}
  </StrictMode>,
);
