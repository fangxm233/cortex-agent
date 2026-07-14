import type { CSSProperties, Ref } from 'react';
import { useVocab } from '@/i18n';

// Pure presentational chrome for the execution log drawer (design 09-exec-logs, prototype.dc.html
// L1544–1560) — hooks-free so it is render-testable and screenshottable in isolation. Exact inline
// styles/px/hex/font from the prototype (the dark palette is not in the light proto.* tokens; raw
// values are faithful per §8.3, matching the LeftRail/RightPanel precedent). Data wiring (executions.
// get / executions.log / executions.cancel) lives in ExecutionLogDrawer's DrawerBody.

export interface LogDrawerViewProps {
  title: string;
  pill: string | null;
  meta: string;
  now: string;
  lines: string[];
  dropped: number;
  /** "waiting for output…" / "no live log …" shown before any lines; null once streaming. */
  notice: string | null;
  killDisabled: boolean;
  onKill: () => void;
  onClose: () => void;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: () => void;
}

const HEADER_STYLE: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '13px 18px',
  borderBottom: '1px solid #2A2F3A',
};

const PILL_STYLE: CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  padding: '1.5px 7px',
  borderRadius: 999,
  background: '#2A2F3A',
  color: '#9AA3E8',
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
  borderTop: '1px solid #2A2F3A',
};

export function LogDrawerView({
  title,
  pill,
  meta,
  now,
  lines,
  dropped,
  notice,
  killDisabled,
  onKill,
  onClose,
  scrollRef,
  onScroll,
}: LogDrawerViewProps) {
  const L = useVocab();
  return (
    <>
      {/* Header (prototype L1545) */}
      <div style={HEADER_STYLE}>
        <span style={{ font: "600 12px 'IBM Plex Mono',monospace", color: '#E8EAF2' }}>{title}</span>
        {pill ? <span style={PILL_STYLE}>{pill}</span> : null}
        <span
          style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: '#5B6472' }}
        >
          {meta}
        </span>
        <span
          onClick={onClose}
          aria-label="Close"
          role="button"
          tabIndex={0}
          style={{ color: '#8A93A2', fontSize: 13, cursor: 'pointer', padding: '2px 4px' }}
        >
          ✕
        </span>
      </div>

      {/* Log body (prototype L1551) */}
      <div ref={scrollRef} onScroll={onScroll} data-execution-log style={BODY_STYLE}>
        {notice ? <div style={{ color: '#5B6472' }}>{notice}</div> : null}
        {dropped > 0 ? (
          <div style={{ color: '#C79A3E' }}>
            … {dropped} {L.exLinesDropped}
          </div>
        ) : null}
        {lines.map((line, i) => (
          <div key={i} style={{ color: '#C6CBE8', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {line}
          </div>
        ))}
        {/* Trailing live-clock (prototype L1555) */}
        <div>
          <span style={{ color: '#5B6472' }}>{now}</span>
        </div>
      </div>

      {/* Footer (prototype L1557) */}
      <div style={FOOTER_STYLE}>
        <span style={{ font: "400 9.5px 'IBM Plex Mono',monospace", color: '#5B6472' }}>
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
            color: '#E88',
            border: '1px solid #4A3336',
            borderRadius: 7,
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
