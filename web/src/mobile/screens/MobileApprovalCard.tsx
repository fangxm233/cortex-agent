// @ds-adherence-ignore -- mobile over-budget approval card, 1:1 from scheme.dc.html L2975-2986 (raw
// px/hex/font by design, §8.3; mobile palette is not in the light `proto.*` token set).
const mono = "'IBM Plex Mono',monospace";

export function MobileApprovalCard({
  id,
  title,
  desc,
  needsApprovalLabel,
  approveLabel,
  denyLabel,
  disabled,
  onApprove,
  onDeny,
}: {
  id: string;
  title: string;
  desc: string;
  needsApprovalLabel: string;
  approveLabel: string;
  denyLabel: string;
  disabled: boolean;
  onApprove: () => void;
  onDeny: () => void;
}): JSX.Element {
  return (
    <div style={{ border: '1px solid var(--proto-amber-border)', background: 'var(--proto-amber-bg)', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'var(--pill-waiting-bg)',
            color: 'var(--proto-amber-fg)',
          }}
        >
          {needsApprovalLabel}
        </span>
        <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-amber-accent)' }}>{id}</span>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--proto-ink)', marginTop: 8 }}>{title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--proto-muted)', marginTop: 3 }}>{desc}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
        <div
          data-action="approve"
          onClick={disabled ? undefined : onApprove}
          style={{
            flex: 1,
            height: 44,
            borderRadius: 11,
            background: 'var(--proto-ink)',
            color: 'var(--ink-solid-fg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 600,
            opacity: disabled ? 0.6 : 1,
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          {approveLabel}
        </div>
        <div
          data-action="deny"
          onClick={disabled ? undefined : onDeny}
          style={{
            flex: 1,
            height: 44,
            borderRadius: 11,
            border: '1.5px solid var(--proto-line-3)',
            background: 'var(--proto-card)',
            color: 'var(--proto-ink)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 600,
            boxSizing: 'border-box',
            opacity: disabled ? 0.6 : 1,
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          {denyLabel}
        </div>
      </div>
    </div>
  );
}
