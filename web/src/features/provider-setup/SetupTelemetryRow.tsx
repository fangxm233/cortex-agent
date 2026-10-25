import { useSyncExternalStore } from 'react';
import { useLang, useVocab } from '@/i18n';
import { TelemetryDocsLink } from '@/features/telemetry/TelemetryDocsLink';
import { setupTelemetry } from './setup-telemetry';

/** "Help improve Cortex": the setup opt-in, on by default. */
export function SetupTelemetryRow({ className }: { className?: string }) {
  const L = useVocab();
  const lang = useLang();
  const enabled = useSyncExternalStore(setupTelemetry.subscribe, setupTelemetry.enabled);
  return <label className={className ? `onb-toggle-row ${className}` : 'onb-toggle-row'} data-setup-telemetry>
    <div><strong>{L.tmShareTitle}</strong>
      <p className="setup-hint">{L.tmShareDesc} <TelemetryDocsLink className="onb-inline-link" /></p></div>
    <input className="onb-toggle" type="checkbox" checked={enabled} aria-label={L.tmShareTitle}
      onChange={(event) => setupTelemetry.set(event.target.checked, lang)} />
  </label>;
}
