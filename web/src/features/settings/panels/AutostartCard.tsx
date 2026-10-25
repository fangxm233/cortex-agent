import type { CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { SRow, Toggle } from '@/features/settings/ui/settings-ui';
import { autostartToggle, type AutostartController } from '@/features/settings/controllers/useAutostartController';

const ALERT_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--proto-danger)', marginTop: 6 };

/** Start at login. Shown only in the desktop app connected to a server it installed. */
export function AutostartRow({ controller }: { controller: AutostartController }) {
  const L = useVocab();
  if (!controller.state) return null;
  const onClick = autostartToggle(controller);
  return (
    <SRow data-autostart="" data-setting-value={controller.state} title={L.onbStartAtLogin}
      desc={controller.state === 'external' ? L.autostartExternal : L.autostartDesc}
      control={<Toggle on={controller.state === 'on'} onClick={onClick} inert={!onClick}
        ariaLabel={L.onbStartAtLogin} />}>
      {controller.failed ? <div role="alert" style={ALERT_STYLE}>{L.autostartFailed}</div> : null}
    </SRow>
  );
}
