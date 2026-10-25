import type { CSSProperties } from 'react';
import { usePairedApps, type PairedAppsController } from '@/features/devices/usePairedApps';
import type { ActiveCodeView, PairedAppRow } from '@/features/devices/paired-apps-vm';
import { MONO } from '@/design/mobile-tokens';
import { useVocab } from '@/i18n';
import { MButton, MC } from '@/mobile/ui/kit';
import { MSET_INSET, MSET_SUB, MSettingsGroup, MSettingsGroupLabel } from './MSettingsControls';

const META: CSSProperties = { fontSize: 12.5, color: MC.muted, fontVariantNumeric: 'tabular-nums' };

function CodeCard({ code, onCopyCode, onCopyLink }: { code: ActiveCodeView; onCopyCode: () => void; onCopyLink: () => void }) {
  const L = useVocab();
  return (
    <div data-pairing-code="" style={{ padding: `0 ${MSET_INSET}px` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 650, letterSpacing: '0.06em', color: MC.ink }}>{code.code}</span>
        <span style={META}>{code.expires}</span>
      </div>
      <div style={MSET_SUB}>{code.hint}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <MButton compact onClick={onCopyCode}>{L.pairCopyCode}</MButton>
        {code.link && <MButton compact onClick={onCopyLink}>{L.pairCopyLink}</MButton>}
      </div>
    </div>
  );
}

function AppRow({ row, onRevoke }: { row: PairedAppRow; onRevoke: (row: PairedAppRow) => void }) {
  const L = useVocab();
  return (
    <div data-paired-app={row.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: `10px ${MSET_INSET}px`, minHeight: 44 }}>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: MC.ink }}>{row.name}</span>
          {row.current && <span style={{ fontSize: 12, color: MC.muted }}>{L.pairThisDevice}</span>}
        </span>
        <span style={{ ...META, display: 'block', marginTop: 2 }}>{row.meta}</span>
      </span>
      {!row.current && <button type="button" onClick={() => onRevoke(row)}
        style={{ flex: 'none', border: 0, background: 'none', padding: '6px 0', fontSize: 13, fontWeight: 600, color: MC.fail }}>
        {L.pairRevoke}
      </button>}
    </div>
  );
}

export function MPairedAppsView({ controller: c }: { controller: PairedAppsController }) {
  const L = useVocab();
  if (!c.visible) return null;
  return (
    <div data-paired-apps="" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <MSettingsGroupLabel>{L.pairAppsTitle}</MSettingsGroupLabel>
      {c.code && <CodeCard code={c.code} onCopyCode={c.copyCode} onCopyLink={c.copyLink} />}
      {c.rows.length > 0
        ? <MSettingsGroup>{c.rows.map((row) => <AppRow key={row.id} row={row} onRevoke={c.revoke} />)}</MSettingsGroup>
        : !c.code && <div style={{ ...META, padding: `0 ${MSET_INSET}px` }}>{L.pairEmpty}</div>}
      {c.pairing && <MButton data-pairing-create="" onClick={c.createCode} disabled={c.creating}>{L.pairConnect}</MButton>}
    </div>
  );
}

export function MPairedApps() {
  return <MPairedAppsView controller={usePairedApps()} />;
}
