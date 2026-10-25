import { useEffect, useState } from 'react';
import { isDesktopShell } from '@/lib/desktop-config';
import { safeInvoke, type NativeAutostartState } from '@/lib/native-bridge';

export interface AutostartController {
  /** Null until the shell answers, and for good where there is nothing to offer. */
  state: NativeAutostartState | null;
  pending: boolean;
  failed: boolean;
  set: (enabled: boolean) => void;
}

/** Start at login for a local install. Shared by Settings → Advanced and the post-install page. */
export function useAutostartController(): AutostartController {
  const desktop = isDesktopShell();
  const [state, setState] = useState<NativeAutostartState | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    // A remote connection, or a shell that predates the command, rejects: nothing to offer.
    void safeInvoke('autostart_status').then((result) => { if (alive && result.ok) setState(result.value); });
    return () => { alive = false; };
  }, [desktop]);

  // The shell answers with the state it ends up in, so the switch shows what is registered.
  const write = async (enabled: boolean) => {
    setPending(true);
    setFailed(false);
    const result = await safeInvoke('autostart_set', { enabled });
    if (result.ok) setState(result.value);
    else setFailed(true);
    setPending(false);
  };
  return { state, pending, failed, set: (enabled) => { if (!pending) void write(enabled); } };
}

/** The switch's click handler, or undefined while it cannot be changed here. */
export function autostartToggle(controller: AutostartController): (() => void) | undefined {
  const { state, pending } = controller;
  if (!state || state === 'external' || pending) return undefined;
  return () => controller.set(state !== 'on');
}
