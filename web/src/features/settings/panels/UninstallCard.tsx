import { useEffect, useState, type CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { isDesktopShell } from '@/lib/desktop-config';
import { safeInvoke } from '@/lib/native-bridge';
import { SButton, SRow, SRowGroup } from '@/features/settings/ui/settings-ui';

const ALERT_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--proto-danger)', marginTop: 6 };

/** Settings entry for the uninstaller. Hidden off the desktop shell and on shells that predate it. */
export function UninstallCard() {
  const L = useVocab();
  const desktop = isDesktopShell();
  const [offered, setOffered] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void safeInvoke('uninstall_info').then((result) => { if (alive) setOffered(result.ok); });
    return () => { alive = false; };
  }, [desktop]);

  if (!offered) return null;
  // On success the app quits while the uninstaller opens, so only a failure comes back here.
  const open = async () => {
    setFailed(false);
    const result = await safeInvoke('uninstall_open');
    if (!result.ok) setFailed(true);
  };
  return (
    <SRowGroup data-uninstall="">
      <SRow title={L.uninstCardTitle} desc={L.uninstCardDesc}
        control={<SButton tone="danger" data-uninstall-open="" onClick={() => void open()}>{L.uninstCardAction}</SButton>}>
        {failed ? <div role="alert" style={ALERT_STYLE}>{L.uninstOpenFailed}</div> : null}
      </SRow>
    </SRowGroup>
  );
}
