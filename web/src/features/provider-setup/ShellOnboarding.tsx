import { useState } from 'react';
import { createHashRouter, Navigate, RouterProvider, useNavigate } from 'react-router-dom';
import { LangProvider } from '@/i18n';
import { ThemeProvider } from '@/theme';
import { isMobileShell } from '@/lib/desktop-config';
import { SetupHeader } from './SetupHeader';
import { ChooseScreen, RemoteConnectScreen } from './ConnectScreen';
import { LocalSetupScreen } from './LocalSetupScreen';
import './provider-setup.css';
import './onboarding.css';

function Choose() {
  const navigate = useNavigate();
  if (isMobileShell()) return <Navigate to="/remote" replace />;
  return <ChooseScreen onLocal={() => navigate('/local')} onRemote={() => navigate('/remote')} />;
}
function Remote() {
  const navigate = useNavigate();
  return <RemoteConnectScreen onBack={isMobileShell() ? undefined : () => navigate('/')} />;
}
function Local() {
  const navigate = useNavigate();
  return <LocalSetupScreen otherOptions={() => navigate('/', { replace: true })} />;
}

/**
 * The native shell's first-run screens, served at connect.html while the shell has no server: the
 * shell answers that page with the SPA bundled in this build (desktop/src-tauri/src/frontend.rs
 * `resolve_seed`). No server exists yet, so this renders without the tRPC providers; leaving goes
 * through a full page load of index.html once `connect` has saved the credentials.
 */
export function ShellOnboarding() {
  const [router] = useState(() => createHashRouter([
    { path: '/', element: <Choose /> },
    { path: '/remote', element: <Remote /> },
    { path: '/local', element: <Local /> },
    { path: '*', element: <Navigate to="/" replace /> },
  ]));
  return <ThemeProvider><LangProvider>
    <div className="provider-setup">
      <SetupHeader />
      <div className="setup-scroll"><main className="setup-workspace onb"><RouterProvider router={router} /></main></div>
    </div>
  </LangProvider></ThemeProvider>;
}
