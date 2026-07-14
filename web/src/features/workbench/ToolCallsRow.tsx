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
      <div>
        <div
          onClick={() => setExpanded(true)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 11.5,
            color: hover ? '#5B6472' : '#98A1B0',
            flexWrap: 'wrap',
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 9, color: '#B6BDC9' }}>▸</span>
          <span>{text}</span>
          {calls.map((c, i) => (
            <span
              key={i}
              style={{
                font: `400 10.5px ${mono}`,
                background: '#F7F8FA',
                border: '1px solid #EFF1F5',
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
          background: '#FBFBFC',
          border: '1px solid ' + (hover ? '#D9DCE3' : '#EFF1F5'),
          borderRadius: 8,
          padding: '2px 0',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#98A1B0', padding: '6px 13px' }}>
          <span style={{ fontSize: 9, color: '#B6BDC9' }}>▾</span>
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
              borderTop: '1px solid #F3F4F7',
            }}
          >
            <span
              style={{
                font: `600 9px ${mono}`,
                color: '#5B6472',
                background: '#F1F2F5',
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
                color: '#22262E',
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
