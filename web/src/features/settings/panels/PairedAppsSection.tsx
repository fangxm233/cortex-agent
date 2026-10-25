import type { CSSProperties } from 'react';
import { usePairedApps, type PairedAppsController } from '@/features/devices/usePairedApps';
import type { ActiveCodeView, PairedAppRow } from '@/features/devices/paired-apps-vm';
import { useVocab } from '@/i18n';
import {
  ROW_STYLE, SButton, SCode, SEntityName, SEntityRow, SLinkAction, SMeta, SNotice, SRowGroup, SSection,
} from '@/features/settings/ui/settings-ui';

const CODE_STYLE: CSSProperties = { fontSize: 18, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--proto-ink)' };
const HINT_STYLE: CSSProperties = { fontSize: 12, color: 'var(--proto-muted-2)', marginTop: 4, lineHeight: 1.5 };

function CodeRow({ code, onCopyCode, onCopyLink }: { code: ActiveCodeView; onCopyCode: () => void; onCopyLink: () => void }) {
  const L = useVocab();
  return (
    <div data-pairing-code="" style={{ ...ROW_STYLE, flexWrap: 'wrap', rowGap: 8 }}>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <SMeta>{L.pairCodeLabel}</SMeta>
          <span style={CODE_STYLE}><SCode>{code.code}</SCode></span>
          <SMeta>{code.expires}</SMeta>
        </div>
        <div style={HINT_STYLE}>{code.hint}</div>
      </div>
      <SButton tone="neutral" onClick={onCopyCode}>{L.pairCopyCode}</SButton>
      {code.link && <SButton tone="neutral" onClick={onCopyLink}>{L.pairCopyLink}</SButton>}
    </div>
  );
}

function AppRow({ row, onRevoke }: { row: PairedAppRow; onRevoke: (row: PairedAppRow) => void }) {
  const L = useVocab();
  return (
    <SEntityRow data-paired-app={row.id}
      name={<><SEntityName>{row.name}</SEntityName>{row.current && <SMeta>{L.pairThisDevice}</SMeta>}</>}
      meta={row.meta}
      trailing={row.current ? null : <SLinkAction tone="danger" onClick={() => onRevoke(row)}>{L.pairRevoke}</SLinkAction>} />
  );
}

export function PairedAppsSectionView({ controller: c }: { controller: PairedAppsController }) {
  const L = useVocab();
  if (!c.visible) return null;
  const action = c.pairing
    ? <SLinkAction data-pairing-create="" onClick={c.creating ? undefined : c.createCode} disabled={c.creating}>{L.pairConnect}</SLinkAction>
    : undefined;
  const empty = c.rows.length === 0 && !c.code;
  return (
    <SSection label={L.pairAppsTitle} action={action} data-paired-apps="">
      {empty
        ? <SNotice tone="muted">{L.pairEmpty}</SNotice>
        : <SRowGroup>
          {c.code && <CodeRow code={c.code} onCopyCode={c.copyCode} onCopyLink={c.copyLink} />}
          {c.rows.map((row) => <AppRow key={row.id} row={row} onRevoke={c.revoke} />)}
        </SRowGroup>}
    </SSection>
  );
}

export function PairedAppsSection() {
  return <PairedAppsSectionView controller={usePairedApps()} />;
}
