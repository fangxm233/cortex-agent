// input:  the server's /api/ui/session probe
// output: a browser-only "sign out of this browser" card
// pos:    Settings → Advanced. Renders nothing in a native shell (their credential lives in the OS
//         keychain and is managed by the connect flow) or on a server with token login switched off.
// >>> Once updated, update this header and parent AGENTS.md <<<

import { useEffect, useState } from 'react';
import { useVocab } from '@/i18n';
import { isNativeShell, readDesktopConfig } from '@/lib/desktop-config';
import { probeUiSession, uiLogout } from '@/lib/ui-session';
import { SLinkAction, SRow, SRowGroup } from './settings-ui';

export function UiSignOutCard() {
  const L = useVocab();
  const [offered, setOffered] = useState(false);
  const browserMode = !isNativeShell() && !readDesktopConfig();

  useEffect(() => {
    if (!browserMode) return;
    let alive = true;
    probeUiSession()
      .then((s) => { if (alive) setOffered(s.tokenLogin); })
      .catch(() => { /* unreachable server — the gate reports that, this card just stays hidden */ });
    return () => { alive = false; };
  }, [browserMode]);

  if (!offered) return null;

  // Reload rather than route: the session is gone, so the gate must re-decide from scratch what
  // this browser is allowed to see (a Cloudflare Access user, for instance, stays signed in).
  const signOut = async () => {
    await uiLogout();
    window.location.reload();
  };

  // The action is the whole row: there is no second line of copy for it to sit beside.
  return (
    <SRowGroup style={{ maxWidth: 760 }}>
      <SRow title={
        <SLinkAction tone="danger" data-ui-sign-out onClick={() => void signOut()}>
          {L.uiLogoutAction}
        </SLinkAction>
      } />
    </SRowGroup>
  );
}
