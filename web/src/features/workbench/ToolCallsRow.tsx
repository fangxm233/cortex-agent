import { useState } from 'react';
import { useVocab } from '@/i18n';
import type { ToolCall } from './chat-content';

// Collapsed/expanded tool-call row — 1:1 from prototype.dc.html L152–172. Default collapsed: a
// one-line "N tool calls" + tool-label chips; click expands to per-call kind + input rows. Static
// representative content (transcript Stage-4 gap).

const mono = "'IBM Plex Mono',monospace";

export function ToolCallsRow({ calls }: { calls: ToolCall[] }): JSX.Element {
  const L = useVocab();
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  const text = calls.length > 1
    ? `${calls.length} ${L.toolCallsUnit}`
    : `1 ${L.toolCallUnit}`;

  if (!expanded) {
    return (
      // Collapsed row: halve the surrounding flex `gap:16` (−8px top/bottom → 8px effective).
      <div style={{ margin: '-8px 0' }}>
        <div
          onClick={() => setExpanded(true)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 11.5,
            color: hover ? 'var(--proto-muted)' : 'var(--proto-muted-3)',
            flexWrap: 'wrap',
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 9, color: 'var(--proto-faint)' }}>▸</span>
          <span>{text}</span>
          {calls.map((c, i) => (
            <span
              key={i}
              style={{
                font: `400 10.5px ${mono}`,
                background: 'var(--proto-alt)',
                border: '1px solid var(--proto-line-2)',
                padding: '1px 6px',
                borderRadius: 4,
              }}
            >
              {c.label}
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div
        onClick={() => setExpanded(false)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          background: 'var(--proto-rail)',
          border: '1px solid ' + (hover ? 'var(--proto-line-3)' : 'var(--proto-line-2)'),
          borderRadius: 8,
          padding: '2px 0',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--proto-muted-3)', padding: '6px 13px' }}>
          <span style={{ fontSize: 9, color: 'var(--proto-faint)' }}>▾</span>
          <span>{text}</span>
        </div>
        {calls.map((c, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '5.5px 13px',
              borderTop: '1px solid var(--proto-line-soft)',
            }}
          >
            <span
              style={{
                font: `600 9px ${mono}`,
                color: 'var(--proto-muted)',
                background: 'var(--proto-gray)',
                padding: '1.5px 7px',
                borderRadius: 5,
                flex: 'none',
              }}
            >
              {c.kind}
            </span>
            <span
              style={{
                font: `400 10.5px ${mono}`,
                color: 'var(--proto-ink-2)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {c.input}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
