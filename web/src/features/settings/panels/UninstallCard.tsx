import { useEffect, useState, type CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { isDesktopShell } from '@/lib/desktop-config';
import { safeInvoke } from '@/lib/native-bridge';
import { SButton, SRow } from '@/features/settings/ui/settings-ui';

const ALERT_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--proto-danger)', marginTop: 6 };

export interface UninstallController {
  /** True on a desktop shell that ships the uninstaller. */
  offered: boolean;
  failed: boolean;
  open: () => void;
}

/** Settings entry for the uninstaller. Not offered off the desktop shell or on shells that predate it. */
export function useUninstallController(): UninstallController {
  const desktop = isDesktopShell();
  const [offered, setOffered] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void safeInvoke('uninstall_info').then((result) => { if (alive) setOffered(result.ok); });
    return () => { alive = false; };
  }, [desktop]);

  // On success the app quits while the uninstaller opens, so only a failure comes back here.
  const open = async () => {
    setFailed(false);
    const result = await safeInvoke('uninstall_open');
    if (!result.ok) setFailed(true);
  };
  return { offered, failed, open: () => void open() };
}

export function UninstallRow({ controller }: { controller: UninstallController }) {
  const L = useVocab();
  if (!controller.offered) return null;
  return (
    <SRow data-uninstall="" title={L.uninstCardTitle} desc={L.uninstCardDesc}
      control={<SButton tone="danger" data-uninstall-open="" onClick={controller.open}>{L.uninstCardAction}</SButton>}>
      {controller.failed ? <div role="alert" style={ALERT_STYLE}>{L.uninstOpenFailed}</div> : null}
    </SRow>
  );
}
