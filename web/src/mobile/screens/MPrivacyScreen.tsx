import { useNavigate } from 'react-router-dom';
import type { TelemetryInfo } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { MButton, MC } from '@/mobile/ui/kit';
import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { TelemetryShareDesc } from '@/features/settings/panels/PrivacyPanel';
import { buildPrivacyView } from '@/features/settings/vm/privacy-vm';
import {
  useCopyFeedback, usePrivacyController, type PrivacyController,
} from '@/features/settings/controllers/usePrivacyController';
import { MSET_SUB, MSettingsQueryPage, MSettingsRow, MSettingsSection, MSettingsToggle } from './MSettingsControls';

const ID = { fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: MC.muted, overflowWrap: 'anywhere', userSelect: 'all' } as const;

function ShareRow({ info, controller }: { info: TelemetryInfo; controller: PrivacyController }) {
  const L = useVocab();
  const view = buildPrivacyView(info);
  const sub = <><TelemetryShareDesc />
    {view.lockedReason ? <span data-telemetry-locked style={{ ...MSET_SUB, display: 'block', color: MC.amber }}>
      {L[view.lockedReason]}</span> : null}</>;
  return <MSettingsRow dataKey="telemetryEnabled" title={L.tmShareTitle} sub={sub}
    trailing={<MSettingsToggle value={view.on} label={L.tmShareTitle}
      disabled={view.lockedReason !== null || controller.pending} onChange={controller.setEnabled} />} />;
}

function InstallIdRow({ installId }: { installId: string }) {
  const L = useVocab();
  const { copied, copy } = useCopyFeedback(installId);
  const sub = <>{L.tmInstallIdDesc}<span data-telemetry-install-id style={{ ...ID, display: 'block', marginTop: 6 }}>{installId}</span></>;
  return <MSettingsRow title={L.tmInstallId} sub={sub}
    trailing={<MButton compact variant="outline" data-telemetry-copy onClick={copy}>{copied ? L.tmCopied : L.tmCopy}</MButton>} />;
}

export function MPrivacyContent({ info, controller }: { info: TelemetryInfo; controller: PrivacyController }) {
  return <MSettingsSection>
    <ShareRow info={info} controller={controller} />
    <InstallIdRow installId={info.installId} />
  </MSettingsSection>;
}

export function MPrivacyScreen() {
  const L = useVocab();
  const navigate = useNavigate();
  const controller = usePrivacyController();
  return <MSettingsQueryPage title={L.tmNavPrivacy} onBack={() => mobileHeaderBack(navigate, '/m/settings')}
    query={controller.info} errorText={L.tmLoadFailed}>
    {(info) => <MPrivacyContent info={info} controller={controller} />}
  </MSettingsQueryPage>;
}
