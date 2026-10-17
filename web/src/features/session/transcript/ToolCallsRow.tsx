import { useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { fmt, useVocab } from '@/i18n';
import { useTRPCClient } from '@/lib/trpc';
import type { ToolCall } from '@/features/session/composer/chat-content';
import { DebugDetailsModal, DebugInspectButton, type DebugDetail } from './DebugDetailsModal';
import { ToolCallImages } from './ToolCallImages';
import { ThinkingRow } from './HintRow';
import { EventIcon, eventRowStyle, type EventIconName } from './EventRow';
import { bareToolName, leadingCategory, toolCategory, toolRunText, type ToolCategory } from './tool-summary';

const mono = "'IBM Plex Mono',monospace";

// A run of consecutive tool calls: one quiet line saying what the run did ("Ran 6 commands · Edited
// parser.ts"), which opens to the calls themselves — one line each, the command or path in mono.
// The line is the same in both states: opening it turns its caret and hangs the list under it.

const CATEGORY_ICON: Record<ToolCategory | 'thought', EventIconName> = {
  command: 'terminal', read: 'file', edit: 'pencil', search: 'search', web: 'globe', todo: 'list', other: 'circle', thought: 'spark',
};

const panelStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', padding: '2px 0 4px 26px', cursor: 'pointer', animation: 'cxfade .2s ease',
};
const callStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, minWidth: 0 };
const kindStyle: CSSProperties = {
  fontSize: 11.5, fontWeight: 500, color: 'var(--proto-faint)', flex: 'none', padding: '0 5px', margin: '0 -5px',
  borderRadius: 'var(--r-chip)', border: '1px solid transparent',
};
const inputStyle: CSSProperties = {
  font: `400 12px ${mono}`, color: 'var(--proto-ink-3)', minWidth: 0,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};

type Inspect = (event: MouseEvent<HTMLButtonElement>, call: ToolCall) => void;

/** A call whose output went over the debug character threshold: a debugging signal, shown only in
 *  the open list (calls carry `debug` only while the server runs with debugging on). */
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

function CallLine({ call, touch, onInspect }: { call: ToolCall; touch: boolean; onInspect: Inspect }): JSX.Element {
  const category = toolCategory(call.kind);
  return (
    <div className={call.debug ? 'group/tool-call' : undefined} data-tool-call="" style={{ ...callStyle, minHeight: touch ? 30 : 24 }}>
      <span style={{ ...kindStyle, ...toolWarningStyle(call.debug?.overCharacterThreshold === true) }}>
        {category === 'other' ? bareToolName(call.kind) : call.kind}
      </span>
      <span style={{ ...inputStyle, flex: 1 }}>{call.input}</span>
      {call.debug ? <DebugInspectButton compact hoverGroup="tool-call" visible={touch} onClick={(event) => onInspect(event, call)} /> : null}
    </div>
  );
}

/** One call in the open list; a call that returned images hangs them under its line. */
function OpenCall({ call, touch, onInspect }: { call: ToolCall; touch: boolean; onInspect: Inspect }): JSX.Element {
  if (call.thinking) {
    return <div onClick={(event) => event.stopPropagation()}><ThinkingRow text={call.input} touch={touch} /></div>;
  }
  if (!call.images?.length) return <CallLine call={call} touch={touch} onInspect={onInspect} />;
  return (
    <div>
      <CallLine call={call} touch={touch} onInspect={onInspect} />
      <ToolCallImages images={call.images} />
    </div>
  );
}

/** Images read across the row's calls; a row is an image row when every call returned some. */
function imageCount(calls: ToolCall[]): number {
  return calls.every((call) => call.images?.length)
    ? calls.reduce((total, call) => total + call.images!.length, 0)
    : 0;
}

export function ToolCallsRow({ calls, sessionId, touch = false }: {
  calls: ToolCall[];
  sessionId?: string;
  /** Mobile transcript: finger-sized row, no hover state, debug inspection always reachable. */
  touch?: boolean;
}): JSX.Element {
  const L = useVocab();
  const client = useTRPCClient();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<DebugDetail | null>(null);
  const images = imageCount(calls);
  const text = images > 0
    ? fmt(images === 1 ? L.chatToolImagesOne : L.chatToolImagesMany, { n: images })
    : toolRunText(calls, L);
  const icon = images > 0 ? 'file' : CATEGORY_ICON[leadingCategory(calls)];
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
    <div data-tool-calls style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <button ref={buttonRef} type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
        className={`${MENU_FOCUS}${touch ? '' : ' hover:bg-[var(--proto-gray)]'}`} style={eventRowStyle(touch, true)}>
        <span style={{ width: 16, height: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--proto-faint)' }}>
          <EventIcon name={expanded ? 'chevron' : icon} open={expanded} />
        </span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
      </button>
      {expanded ? (
        <>
          <div data-tool-calls-panel onClick={collapse} style={panelStyle}>
            {calls.map((call, index) => <OpenCall key={index} call={call} touch={touch} onInspect={inspect} />)}
          </div>
          <DebugDetailsModal detail={selected} onClose={() => setSelected(null)} />
        </>
      ) : null}
    </div>
  );
}
