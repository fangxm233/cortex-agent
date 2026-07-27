// input:  compact tool calls with optional lossless DEBUG input/result detail
// output: collapsed/expanded tool row plus one hover/focus inspector button per debug call
// pos:    desktop workbench tool-call presentation; mobile renderers do not consume these controls
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useState } from 'react';
import { useVocab } from '@/i18n';
import type { ToolCall } from './chat-content';
import { DebugDetailsModal, DebugInspectButton, type DebugDetail } from './DebugDetailsModal';

const mono = "'IBM Plex Mono',monospace";

function detailFor(call: ToolCall): DebugDetail | null {
  if (!call.debug) return null;
  return {
    kind: 'tool',
    toolName: call.kind,
    toolInput: call.debug.toolInput,
    ...(call.debug.toolResult !== undefined ? { toolResult: call.debug.toolResult } : {}),
  };
}

export function ToolCallsRow({ calls }: { calls: ToolCall[] }): JSX.Element {
  const L = useVocab();
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  const [selected, setSelected] = useState<DebugDetail | null>(null);
  const text = calls.length > 1
    ? `${calls.length} ${L.toolCallsUnit}`
    : `1 ${L.toolCallUnit}`;

  const inspect = (event: React.MouseEvent<HTMLButtonElement>, call: ToolCall): void => {
    event.stopPropagation();
    setSelected(detailFor(call));
  };

  if (!expanded) {
    return (
      <>
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
            {calls.map((call, index) => call.debug ? (
              <span
                key={index}
                className="group"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  font: `400 10.5px ${mono}`,
                  background: 'var(--proto-alt)',
                  border: '1px solid var(--proto-line-2)',
                  padding: '1px 4px 1px 6px',
                  borderRadius: 4,
                }}
              >
                {call.label}
                <DebugInspectButton onClick={(event) => inspect(event, call)} />
              </span>
            ) : (
              <span
                key={index}
                style={{
                  font: `400 10.5px ${mono}`,
                  background: 'var(--proto-alt)',
                  border: '1px solid var(--proto-line-2)',
                  padding: '1px 6px',
                  borderRadius: 4,
                }}
              >
                {call.label}
              </span>
            ))}
          </div>
        </div>
        <DebugDetailsModal detail={selected} onClose={() => setSelected(null)} />
      </>
    );
  }

  return (
    <>
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
          {calls.map((call, index) => (
            <div
              key={index}
              className={call.debug ? 'group' : undefined}
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
                {call.kind}
              </span>
              <span
                style={{
                  ...(call.debug ? { minWidth: 0, flex: 1 } : {}),
                  font: `400 10.5px ${mono}`,
                  color: 'var(--proto-ink-2)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {call.input}
              </span>
              {call.debug ? <DebugInspectButton onClick={(event) => inspect(event, call)} /> : null}
            </div>
          ))}
        </div>
      </div>
      <DebugDetailsModal detail={selected} onClose={() => setSelected(null)} />
    </>
  );
}
