import type { StepDotKind } from './right-panel-vm';

/** Step-timeline node: a done check, a running dot or a pending ring, with an optional tail line. */
export function StepDot({ kind, hasTail }: { kind: StepDotKind; hasTail: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {kind === 'done' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--proto-success-bg)',
            color: 'var(--proto-success)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 8,
            fontWeight: 700,
            flex: 'none',
          }}
        >
          ✓
        </span>
      )}
      {kind === 'running' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--proto-accent)',
            flex: 'none',
            boxShadow: '0 0 0 3px var(--proto-accent-bg)',
          }}
        />
      )}
      {kind === 'pending' && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '1.5px solid var(--proto-line-3)',
            boxSizing: 'border-box',
            flex: 'none',
          }}
        />
      )}
      {hasTail && <span style={{ flex: 1, width: 1.5, background: 'var(--proto-line-2)', margin: '3px 0' }} />}
    </div>
  );
}
