import type { CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { SButton, SRow } from '@/features/settings/ui/settings-ui';
import type { LocalServerController } from '@/features/settings/controllers/useLocalServerController';

const ALERT_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--proto-danger)', marginTop: 6 };

export function StopServerRow({ controller }: { controller: LocalServerController }) {
  const L = useVocab();
  if (!controller.offered) return null;
  const control = controller.armed ? (
    <div style={{ display: 'flex', gap: 8 }}>
      <SButton tone="neutral" data-stop-server-cancel="" onClick={controller.cancel}>{L.dmConfirmCancel}</SButton>
      <SButton tone="danger" data-stop-server-confirm="" disabled={controller.pending} onClick={controller.stop}>
        {L.dmnStopServerConfirm}
      </SButton>
    </div>
  ) : (
    <SButton tone="danger" data-stop-server="" onClick={controller.arm}>{L.dmnStopServer}</SButton>
  );
  return (
    <SRow data-stop-server-row="" title={L.dmnStopServer} desc={L.dmnStopServerDesc} control={control}>
      {controller.failed ? <div role="alert" style={ALERT_STYLE}>{L.dmnStopServerFailed}</div> : null}
    </SRow>
  );
}
