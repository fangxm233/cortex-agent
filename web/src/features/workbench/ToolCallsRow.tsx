// input:  tool calls with DEBUG details and server size warnings
// output: single-line collapsed row with +N overflow, expanded details
// pos:    desktop workbench tool-call presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useState, type CSSProperties, type MouseEvent } from 'react';
import { useVocab } from '@/i18n';
import type { ToolCall } from './chat-content';
import { DebugDetailsModal, DebugInspectButton, type DebugDetail } from './DebugDetailsModal';
import { toolCallOverflowText } from './tool-call-overflow';
import { useToolCallOverflow } from './useToolCallOverflow';

const mono = "'IBM Plex Mono',monospace";
const COLLAPSED_GAP = 7;
const chipStyle: CSSProperties = {
  font: `400 10.5px ${mono}`,
  background: 'var(--proto-alt)',
  border: '1px solid var(--proto-line-2)',
  padding: '1px 6px',
  borderRadius: 4,
  flex: 'none',
};
const overflowStyle: CSSProperties = {
  font: `500 10.5px ${mono}`,
  color: 'var(--proto-muted)',
  flex: 'none',
};
const collapsedCallsStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: COLLAPSED_GAP,
  flex: 1, minWidth: 0, overflow: 'hidden', position: 'relative',
};
const measureStyle: CSSProperties = {
  ...collapsedCallsStyle,
  position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
  width: 'max-content', overflow: 'visible',
};
const expandedHeaderStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7, fontSize: 11,
  color: 'var(--proto-muted-3)', padding: '6px 13px',
};
const expandedCallStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '5.5px 13px', borderTop: '1px solid var(--proto-line-soft)',
};
const kindStyle: CSSProperties = {
  font: `600 9px ${mono}`, color: 'var(--proto-muted)',
  background: 'var(--proto-gray)', padding: '1.5px 7px',
  borderRadius: 5, flex: 'none',
};
const inputStyle: CSSProperties = {
  font: `400 10.5px ${mono}`, color: 'var(--proto-ink-2)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};

type Inspect = (event: MouseEvent<HTMLButtonElement>, call: ToolCall) => void;

function toolWarningStyle(warned: boolean): CSSProperties {
  if (!warned) return {};
  return {
    background: 'var(--proto-amber-bg)',
    border: '1px solid var(--proto-amber-border)',
    color: 'var(--proto-amber-fg)',
  };
}

function detailFor(call: ToolCall): DebugDetail | null {
  if (!call.debug) return null;
  return {
    kind: 'tool',
    toolName: call.kind,
    toolInput: call.debug.toolInput,
    ...(call.debug.toolResult !== undefined ? { toolResult: call.debug.toolResult } : {}),
  };
}

function collapsedRowStyle(hover: boolean): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: COLLAPSED_GAP, fontSize: 11.5,
    color: hover ? 'var(--proto-muted)' : 'var(--proto-muted-3)',
    flexWrap: 'nowrap', whiteSpace: 'nowrap', overflow: 'hidden',
    cursor: 'pointer',
  };
}

function expandedBoxStyle(hover: boolean): CSSProperties {
  return {
    background: 'var(--proto-rail)',
    border: '1px solid ' + (hover ? 'var(--proto-line-3)' : 'var(--proto-line-2)'),
    borderRadius: 8, padding: '2px 0', cursor: 'pointer',
  };
}

function ToolChip({ call }: { call: ToolCall }): JSX.Element {
  return (
    <span style={{ ...chipStyle, ...toolWarningStyle(call.debug?.overCharacterThreshold === true) }}>
      {call.label}
    </span>
  );
}

function CollapsedToolCalls({ calls, text, hover, onExpand, onHover }: {
  calls: ToolCall[];
  text: string;
  hover: boolean;
  onExpand: () => void;
  onHover: (hovered: boolean) => void;
}): JSX.Element {
  const { containerRef, measureRef, layout } = useToolCallOverflow(calls.map((call) => call.label), COLLAPSED_GAP);
  const overflowText = toolCallOverflowText(layout.hiddenCount);
  return (
    <div style={{ margin: '-8px 0' }}>
      <div onClick={onExpand} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} style={collapsedRowStyle(hover)}>
        <span style={{ fontSize: 9, color: 'var(--proto-faint)', flex: 'none' }}>▸</span>
        <span style={{ flex: 'none' }}>{text}</span>
        <span ref={containerRef} style={collapsedCallsStyle}>
          {calls.slice(0, layout.visibleCount).map((call, index) => <ToolChip key={index} call={call} />)}
          {overflowText ? <span style={overflowStyle}>{overflowText}</span> : null}
          <span ref={measureRef} aria-hidden="true" style={measureStyle}>
            {calls.map((call, index) => <ToolChip key={index} call={call} />)}
            <span style={overflowStyle}>+{calls.length}</span>
          </span>
        </span>
      </div>
    </div>
  );
}

function ExpandedToolCall({ call, onInspect }: {
  call: ToolCall;
  onInspect: Inspect;
}): JSX.Element {
  return (
    <div className={call.debug ? 'group' : undefined} style={expandedCallStyle}>
      <span style={{ ...kindStyle, ...toolWarningStyle(call.debug?.overCharacterThreshold === true) }}>{call.kind}</span>
      <span style={{ ...inputStyle, ...(call.debug ? { minWidth: 0, flex: 1 } : {}) }}>{call.input}</span>
      {call.debug ? <DebugInspectButton compact onClick={(event) => onInspect(event, call)} /> : null}
    </div>
  );
}

function ExpandedToolCalls({ calls, text, hover, selected, onCollapse, onHover, onInspect, onClose }: {
  calls: ToolCall[];
  text: string;
  hover: boolean;
  selected: DebugDetail | null;
  onCollapse: () => void;
  onHover: (hovered: boolean) => void;
  onInspect: Inspect;
  onClose: () => void;
}): JSX.Element {
  return (
    <>
      <div onClick={onCollapse} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} style={expandedBoxStyle(hover)}>
        <div style={expandedHeaderStyle}><span style={{ fontSize: 9, color: 'var(--proto-faint)' }}>▾</span><span>{text}</span></div>
        {calls.map((call, index) => <ExpandedToolCall key={index} call={call} onInspect={onInspect} />)}
      </div>
      <DebugDetailsModal detail={selected} onClose={onClose} />
    </>
  );
}

export function ToolCallsRow({ calls }: { calls: ToolCall[] }): JSX.Element {
  const L = useVocab();
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  const [selected, setSelected] = useState<DebugDetail | null>(null);
  const text = calls.length > 1 ? `${calls.length} ${L.toolCallsUnit}` : `1 ${L.toolCallUnit}`;
  const inspect: Inspect = (event, call) => {
    event.stopPropagation();
    setSelected(detailFor(call));
  };
  if (!expanded) {
    return <CollapsedToolCalls calls={calls} text={text} hover={hover} onExpand={() => setExpanded(true)} onHover={setHover} />;
  }
  return (
    <ExpandedToolCalls calls={calls} text={text} hover={hover} selected={selected}
      onCollapse={() => setExpanded(false)} onHover={setHover} onInspect={inspect} onClose={() => setSelected(null)} />
  );
}
