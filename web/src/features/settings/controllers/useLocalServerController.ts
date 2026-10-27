import { useEffect, useState } from 'react';
import { isDesktopShell } from '@/lib/desktop-config';
import { safeInvoke } from '@/lib/native-bridge';

export interface LocalServerController {
  /** True in the desktop app connected to a server it installed, on a shell that can stop it. */
  offered: boolean;
  /** The confirmation is showing. */
  armed: boolean;
  pending: boolean;
  failed: boolean;
  arm: () => void;
  cancel: () => void;
  stop: () => void;
}

/** Stop the local server. Shared by the Daemon sheet and Settings → Advanced → Device. */
export function useLocalServerController(): LocalServerController {
  const desktop = isDesktopShell();
  const [offered, setOffered] = useState(false);
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    // A remote connection, or a shell that predates the command, rejects: nothing to offer.
    void safeInvoke('local_server_status').then((result) => { if (alive) setOffered(result.ok); });
    return () => { alive = false; };
  }, [desktop]);

  // On success the shell quits, so only a failure comes back here.
  const stop = async () => {
    setPending(true);
    setFailed(false);
    const result = await safeInvoke('local_server_stop');
    if (!result.ok) {
      setFailed(true);
      setPending(false);
      setArmed(false);
    }
  };
  return {
    offered, armed, pending, failed,
    arm: () => { setFailed(false); setArmed(true); },
    cancel: () => setArmed(false),
    stop: () => { if (!pending) void stop(); },
  };
}
