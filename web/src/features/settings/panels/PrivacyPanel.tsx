import type { CSSProperties } from 'react';
import type { TelemetryInfo } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { SButton, SRow, SRowGroup, Toggle } from '@/features/settings/ui/settings-ui';
import { buildPrivacyView } from '@/features/settings/vm/privacy-vm';
import {
  useCopyFeedback, usePrivacyController, type PrivacyController,
} from '@/features/settings/controllers/usePrivacyController';

const LINK: CSSProperties = { color: 'var(--proto-accent)', whiteSpace: 'nowrap' };
const STATE: CSSProperties = { fontSize: 12, color: 'var(--proto-muted-3)' };
const ID: CSSProperties = {
  fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: 'var(--proto-muted)',
  overflowWrap: 'anywhere', userSelect: 'all',
};
const REASON: CSSProperties = { marginTop: 4, fontSize: 12, color: 'var(--proto-amber)' };

/** The description and docs link under the switch; read by both chromes. */
export function TelemetryShareDesc() {
  const L = useVocab();
  return <>{L.tmShareDesc}{' '}
    <a href={L.tmDocsUrl} target="_blank" rel="noreferrer" style={LINK}>{L.tmLearnMore}</a></>;
}

function ShareRow({ info, controller }: { info: TelemetryInfo; controller: PrivacyController }) {
  const L = useVocab();
  const view = buildPrivacyView(info);
  const onClick = view.lockedReason || controller.pending ? undefined : () => controller.setEnabled(!view.on);
  return <SRow data-setting-key="telemetryEnabled" data-setting-value={String(view.on)}
    title={L.tmShareTitle} desc={<TelemetryShareDesc />}
    control={<Toggle on={view.on} onClick={onClick} inert={!onClick} ariaLabel={L.tmShareTitle} />}>
    {view.lockedReason ? <div data-telemetry-locked style={REASON}>{L[view.lockedReason]}</div> : null}
  </SRow>;
}

function InstallIdRow({ installId }: { installId: string }) {
  const L = useVocab();
  const { copied, copy } = useCopyFeedback(installId);
  return <SRow title={L.tmInstallId} desc={L.tmInstallIdDesc}
    control={<SButton tone="neutral" data-telemetry-copy onClick={copy}>{copied ? L.tmCopied : L.tmCopy}</SButton>}>
    <div data-telemetry-install-id style={{ ...ID, marginTop: 6 }}>{installId}</div>
  </SRow>;
}

export function PrivacyPanelView({ controller }: { controller: PrivacyController }) {
  const L = useVocab();
  const { info } = controller;
  if (info.isLoading) return <div style={STATE}>{L.stLoadingConfig}</div>;
  if (!info.data) return <div style={{ ...STATE, color: 'var(--proto-danger)' }}>{L.tmLoadFailed}</div>;
  return <SRowGroup>
    <ShareRow info={info.data} controller={controller} />
    <InstallIdRow installId={info.data.installId} />
  </SRowGroup>;
}

export function PrivacyPanel() {
  return <PrivacyPanelView controller={usePrivacyController()} />;
}
