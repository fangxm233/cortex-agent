// input:  Tool calls, overflow measurement, debug details
// output: ToolCallsRow
// pos:    Spaced tool groups with click-anywhere detail collapse
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useRef, useState, type CSSProperties, type MouseEvent, type Ref } from 'react';
import { MENU_BUTTON_STYLE, MENU_FOCUS } from './MenuChrome';
import { useVocab } from '@/i18n';
import { useTRPCClient } from '@/lib/trpc';
import type { ToolCall } from './chat-content';
import { DebugDetailsModal, DebugInspectButton, type DebugDetail } from './DebugDetailsModal';
import { toolCallOverflowText } from './tool-call-overflow';
import { TOOL_CALL_MEASURE_CAP, useToolCallOverflow } from './useToolCallOverflow';

const mono = "'IBM Plex Mono',monospace";
const COLLAPSED_GAP = 7;
const chipStyle: CSSProperties = {
  font: `400 11px ${mono}`,
  // Control material, no filter: these chips live in the scrolling transcript.
  background: 'var(--material-control-bg)',
  boxShadow: 'var(--material-control-shadow)',
  border: '1px solid var(--proto-line-2)',
  padding: '1px 6px',
  borderRadius: 'var(--r-chip)',
  flex: 'none',
};
const overflowStyle: CSSProperties = {
  font: `500 11px ${mono}`,
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
const expandedPanelStyle: CSSProperties = {
  background: 'var(--material-card-bg)',
  boxShadow: 'var(--material-card-shadow)',
  border: '1px solid var(--proto-line)',
  borderRadius: 'var(--r-card)',
  padding: '2px 0',
  cursor: 'pointer',
  animation: 'cxfade .2s ease',
};
const expandedCallStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 13px', borderTop: '1px solid var(--proto-line-2)',
};
const kindStyle: CSSProperties = {
  font: `600 11px ${mono}`, color: 'var(--proto-muted)',
  background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', padding: '1.5px 7px',
  borderRadius: 'var(--r-chip)', flex: 'none',
};
const inputStyle: CSSProperties = {
  font: `400 11px ${mono}`, color: 'var(--proto-ink-2)',
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
    ...(call.debug.toolRef ? { toolRef: call.debug.toolRef } : {}),
    ...(call.debug.toolInput !== undefined ? { toolInput: call.debug.toolInput } : {}),
    ...(call.debug.toolResult !== undefined ? { toolResult: call.debug.toolResult } : {}),
  };
}

function collapsedRowStyle(hover: boolean): CSSProperties {
  return {
    ...MENU_BUTTON_STYLE, padding: 0, background: 'transparent',
    display: 'flex', alignItems: 'center', gap: COLLAPSED_GAP, fontSize: 11.5,
    color: hover ? 'var(--proto-ink)' : 'var(--proto-muted)',
    flexWrap: 'nowrap', whiteSpace: 'nowrap', overflow: 'hidden',
    cursor: 'pointer',
  };
}

function ToolChip({ call }: { call: ToolCall }): JSX.Element {
  return (
    <span style={{ ...chipStyle, ...toolWarningStyle(call.debug?.overCharacterThreshold === true) }}>
      {call.label}
    </span>
  );
}

// The summary row is the same in both states — expanding flips its caret and hangs a panel under
// it rather than replacing it, so the chips stay readable while the detail is open.
function ToolCallsSummaryRow({ calls, text, expanded, hover, onToggle, onHover, buttonRef }: {
  calls: ToolCall[];
  text: string;
  expanded: boolean;
  hover: boolean;
  onToggle: () => void;
  onHover: (hovered: boolean) => void;
  buttonRef: Ref<HTMLButtonElement>;
}): JSX.Element {
  const { containerRef, measureRef, layout } = useToolCallOverflow(calls.map((call) => call.label), COLLAPSED_GAP);
  const overflowText = toolCallOverflowText(layout.hiddenCount);
  return (
    <div>
      <button ref={buttonRef} type="button" className={MENU_FOCUS} aria-expanded={expanded} onClick={onToggle} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} style={collapsedRowStyle(hover)}>
        <span style={{ fontSize: 9, color: 'var(--proto-muted)', flex: 'none' }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ flex: 'none' }}>{text}</span>
        <span ref={containerRef} style={collapsedCallsStyle}>
          {calls.slice(0, layout.visibleCount).map((call, index) => <ToolChip key={index} call={call} />)}
          {overflowText ? <span style={overflowStyle}>{overflowText}</span> : null}
          <span ref={measureRef} aria-hidden="true" style={measureStyle}>
            {calls.slice(0, TOOL_CALL_MEASURE_CAP).map((call, index) => <ToolChip key={index} call={call} />)}
            <span style={overflowStyle}>+{calls.length}</span>
          </span>
        </span>
      </button>
    </div>
  );
}

function ExpandedToolCall({ call, first, onInspect }: {
  call: ToolCall;
  first: boolean;
  onInspect: Inspect;
}): JSX.Element {
  return (
    <div className={call.debug ? 'group/tool-call' : undefined} style={{ ...expandedCallStyle, ...(first ? { borderTop: 'none' } : {}) }}>
      <span style={{ ...kindStyle, ...toolWarningStyle(call.debug?.overCharacterThreshold === true) }}>{call.kind}</span>
      <span style={{ ...inputStyle, ...(call.debug ? { minWidth: 0, flex: 1 } : {}) }}>{call.input}</span>
      {call.debug ? <DebugInspectButton compact hoverGroup="tool-call" onClick={(event) => onInspect(event, call)} /> : null}
    </div>
  );
}

function ExpandedToolCalls({ calls, selected, onInspect, onClose, onCollapse }: {
  calls: ToolCall[];
  selected: DebugDetail | null;
  onInspect: Inspect;
  onClose: () => void;
  onCollapse: () => void;
}): JSX.Element {
  return (
    <>
      <div data-tool-calls-panel onClick={onCollapse} style={expandedPanelStyle}>
        {calls.map((call, index) => <ExpandedToolCall key={index} call={call} first={index === 0} onInspect={onInspect} />)}
      </div>
      <DebugDetailsModal detail={selected} onClose={onClose} />
    </>
  );
}

export function ToolCallsRow({ calls, sessionId }: {
  calls: ToolCall[];
  sessionId?: string;
}): JSX.Element {
  const L = useVocab();
  const client = useTRPCClient();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  const [selected, setSelected] = useState<DebugDetail | null>(null);
  const text = calls.length > 1 ? `${calls.length} ${L.toolCallsUnit}` : `1 ${L.toolCallUnit}`;
  const inspect: Inspect = (event, call) => {
    event.stopPropagation();
    const detail = detailFor(call);
    setSelected(detail);
    const ref = call.debug?.toolRef;
    if (!detail || !sessionId || !ref || call.debug?.toolResult) return;
    void client.sessions.debugDetails.query({ sessionId, ref }).then((loaded) => {
      if (!loaded) return;
      setSelected((current) => current?.kind === 'tool' && current.toolRef === ref
        ? { ...current, toolInput: loaded.toolInput, toolResult: loaded.toolResult }
        : current);
    }).catch(() => {});
  };
  const collapse = (): void => { setExpanded(false); buttonRef.current?.focus(); };
  return (
    <div data-tool-calls style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '-8px 0' }}>
      <ToolCallsSummaryRow calls={calls} text={text} expanded={expanded} hover={hover} onToggle={() => setExpanded((value) => !value)} onHover={setHover} buttonRef={buttonRef} />
      {expanded ? <ExpandedToolCalls calls={calls} selected={selected} onInspect={inspect} onClose={() => setSelected(null)} onCollapse={collapse} /> : null}
    </div>
  );
}
