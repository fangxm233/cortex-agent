import { useEffect, useState } from 'react';
import { isNativeShell, readDesktopConfig } from '@/lib/desktop-config';
import { probeUiSession, uiLogout } from '@/lib/ui-session';

export interface UiSignOut {
  /** True only in a plain browser signed in with the server's token login. */
  offered: boolean;
  signOut: () => Promise<void>;
}

/** Sign-out for a browser that logged in with the UI token; the native apps never offer it. */
export function useUiSignOut(): UiSignOut {
  const [offered, setOffered] = useState(false);
  const browserMode = !isNativeShell() && !readDesktopConfig();

  useEffect(() => {
    if (!browserMode) return;
    let alive = true;
    probeUiSession()
      .then((s) => { if (alive) setOffered(s.tokenLogin); })
      .catch(() => { /* unreachable server — the gate reports that, the action just stays hidden */ });
    return () => { alive = false; };
  }, [browserMode]);

  // Reload rather than route: the session is gone, so the gate must re-decide from scratch what
  // this browser is allowed to see (a Cloudflare Access user, for instance, stays signed in).
  const signOut = async () => {
    await uiLogout();
    window.location.reload();
  };
  return { offered, signOut };
}
