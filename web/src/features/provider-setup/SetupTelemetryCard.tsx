import { useVocab } from '@/i18n';
import { Toggle } from '@/features/settings/ui/settings-ui';
import { buildPrivacyView } from '@/features/settings/vm/privacy-vm';
import type { PrivacyController } from '@/features/settings/controllers/usePrivacyController';
import { TelemetryDocsLink } from '@/features/telemetry/TelemetryDocsLink';

/** "Help improve Cortex" on the first page after install; Settings → Privacy offers it later. */
export function SetupTelemetryCard({ controller }: { controller: PrivacyController }) {
  const L = useVocab();
  const info = controller.info.data;
  // Nothing to offer until the server answers, nor at all from one without `telemetry.info`.
  if (!info) return null;
  const view = buildPrivacyView(info);
  const onClick = view.lockedReason || controller.pending ? undefined : () => controller.setEnabled(!view.on);
  return <section className="setup-card" data-setup-telemetry data-setting-value={String(view.on)}>
    <div className="setup-card-header"><h2>{L.tmShareTitle}</h2>
      <span style={{ marginLeft: 'auto', display: 'flex' }}>
        <Toggle on={view.on} onClick={onClick} inert={!onClick} ariaLabel={L.tmShareTitle} /></span></div>
    <div className="setup-card-body"><p className="setup-hint">{L.tmShareDesc}{' '}
      <TelemetryDocsLink className="setup-inline-link" /></p>
      {view.lockedReason ? <p className="setup-hint setup-telemetry-locked" data-telemetry-locked>
        {L[view.lockedReason]}</p> : null}</div>
  </section>;
}
