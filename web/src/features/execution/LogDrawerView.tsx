import type { CSSProperties } from 'react';
import { useVocab } from '@/i18n';

// Pure presentational chrome for the execution drawer (design 09-exec-logs, prototype.dc.html
// L1544–1560) — hooks-free so it is render-testable and screenshottable in isolation. Exact inline
// styles/px/hex/font from the prototype (the dark palette is not in the light proto.* tokens; raw
// values are faithful per §8.3, matching the LeftRail/RightPanel precedent). Data wiring
// (executions.get / executions.cancel) lives in ExecutionLogDrawer's DrawerBody.

export interface LogDrawerViewProps {
  title: string;
  pill: string | null;
  meta: string;
  now: string;
  /** Body line explaining that no output is captured for this execution. */
  notice: string | null;
  killDisabled: boolean;
  onKill: () => void;
  onClose: () => void;
}

const HEADER_STYLE: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '13px 18px',
  borderBottom: '1px solid var(--log-border)',
};

const PILL_STYLE: CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  padding: '1.5px 7px',
  borderRadius: 'var(--r-pill)',
  background: 'var(--log-border)',
  color: 'var(--proto-accent-2)',
};

const BODY_STYLE: CSSProperties = {
  flex: 1,
  overflow: 'auto',
  minHeight: 0,
  padding: '13px 18px',
  font: "400 10.5px/2 'IBM Plex Mono',monospace",
};

const FOOTER_STYLE: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '11px 18px',
  borderTop: '1px solid var(--log-border)',
};

export function LogDrawerView({
  title,
  pill,
  meta,
  now,
  notice,
  killDisabled,
  onKill,
  onClose,
}: LogDrawerViewProps) {
  const L = useVocab();
  return (
    <>
      {/* Header (prototype L1545) */}
      <div style={HEADER_STYLE}>
        <span style={{ font: "600 12px 'IBM Plex Mono',monospace", color: 'var(--proto-line)' }}>{title}</span>
        {pill ? <span style={PILL_STYLE}>{pill}</span> : null}
        <span
          style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}
        >
          {meta}
        </span>
        <span
          onClick={onClose}
          aria-label="Close"
          role="button"
          tabIndex={0}
          style={{ color: 'var(--proto-muted-2)', fontSize: 13, cursor: 'pointer', padding: '2px 4px' }}
        >
          ✕
        </span>
      </div>

      {/* Body (prototype L1551) */}
      <div data-execution-log style={BODY_STYLE}>
        {notice ? <div style={{ color: 'var(--proto-muted)' }}>{notice}</div> : null}
        {/* Trailing live-clock (prototype L1555) */}
        <div>
          <span style={{ color: 'var(--proto-muted)' }}>{now}</span>
        </div>
      </div>

      {/* Footer (prototype L1557) */}
      <div style={FOOTER_STYLE}>
        <span style={{ font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>
          {L.exFooterHeartbeat}
        </span>
        <button
          type="button"
          onClick={onKill}
          disabled={killDisabled}
          data-action="kill-run"
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--proto-danger)',
            border: '1px solid var(--proto-danger)',
            borderRadius: 'var(--r-control)',
            padding: '4px 12px',
            cursor: killDisabled ? 'default' : 'pointer',
            background: 'transparent',
          }}
        >
          {L.exKillRun}
        </button>
      </div>
    </>
  );
}
