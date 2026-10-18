import { useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Collapse, useEntryAnimation } from '@/design/Collapse';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { SwapText } from '@/design/SwapText';
import { fmt, useVocab, type Vocab } from '@/i18n';
import { useTRPCClient } from '@/lib/trpc';
import type { ToolCall } from '@/features/session/composer/chat-content';
import { DebugDetailsModal, DebugInspectButton, type DebugDetail } from './DebugDetailsModal';
import { ToolCallImages } from './ToolCallImages';
import { ThinkingRow } from './HintRow';
import { EventIcon, eventRowStyle, type EventIconName } from './EventRow';
import { bareToolName, leadingCategory, toolCategory, toolRunNow, toolRunText, type ToolCategory } from './tool-summary';

const mono = "'IBM Plex Mono',monospace";

// A run of consecutive tool calls: one quiet line saying what the run did ("Ran 6 commands · Edited
// parser.ts"), which opens to the calls themselves — one line each, the command or path in mono.
// The line is the same in both states: opening it turns its caret and hangs the list under it.
// While the run is what the agent is doing right now, the line ends with the step under way
// ("Running pnpm test", "Thinking") — a thought being written joins the run as its latest entry —
// and its words roll to the next step rather than jump.

const CATEGORY_ICON: Record<ToolCategory | 'thought', EventIconName> = {
  command: 'terminal', read: 'file', edit: 'pencil', search: 'search', web: 'globe', todo: 'list', other: 'circle', thought: 'spark',
};

const panelStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', padding: '8px 0 8px 26px', cursor: 'pointer',
};
const callStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 25, minWidth: 0 };
const kindStyle: CSSProperties = {
  fontSize: 11.5, fontWeight: 500, color: 'var(--proto-faint)', flex: 'none', padding: '0 5px', margin: '0 -5px',
  borderRadius: 'var(--r-chip)', border: '1px solid transparent',
};
const iconBoxStyle: CSSProperties = {
  width: 16, height: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--proto-faint)',
};
// The line cuts from its end: what the run did keeps its words, and the step under way gives way.
const nowStyle: CSSProperties = {
  color: 'var(--proto-ink-3)', fontWeight: 550, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
};
const doneStyle: CSSProperties = { flex: 'none', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' };
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
    <div className={call.debug ? 'group/tool-call' : undefined} data-tool-call="" style={{ ...callStyle, minHeight: touch ? 30 : 25 }}>
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
    return <div onClick={(event) => event.stopPropagation()}><ThinkingRow text={call.input} preview={call.preview} touch={touch} /></div>;
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

/** What the calls did, in the past tense: "Ran 6 commands · Edited parser.ts". */
function doneText(calls: ToolCall[], L: Vocab): string {
  const images = imageCount(calls);
  return images > 0 ? fmt(images === 1 ? L.chatToolImagesOne : L.chatToolImagesMany, { n: images }) : toolRunText(calls, L);
}

interface RunLine {
  icon: EventIconName;
  /** The step under way, while the run is what the agent is doing right now. */
  now: string | null;
  done: string;
}

/** The run's line: what it did, and — while it is the live step — what it is doing now, last, where
 *  the eye lands at the end of the line. */
function runLine(calls: ToolCall[], live: boolean, L: Vocab): RunLine {
  const icon = imageCount(calls) > 0 ? 'file' : CATEGORY_ICON[leadingCategory(calls)];
  if (!live) return { icon, now: null, done: doneText(calls, L) };
  const latest = calls[calls.length - 1];
  return { icon, now: toolRunNow(latest, L), done: doneText(calls.slice(0, -1), L) };
}

function useCallInspect(sessionId: string | undefined): { selected: DebugDetail | null; clear: () => void; inspect: Inspect } {
  const client = useTRPCClient();
  const [selected, setSelected] = useState<DebugDetail | null>(null);
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
  return { selected, clear: () => setSelected(null), inspect };
}

function RunLineText({ line }: { line: RunLine }): JSX.Element {
  return (
    <SwapText swapKey={`${line.now ?? ''}\n${line.done}`} style={{ flex: 1 }}>
      {line.done ? <span style={doneStyle}>{line.done}</span> : null}
      {line.now ? <span data-tool-now="" style={nowStyle}>{line.now}</span> : null}
    </SwapText>
  );
}

export function ToolCallsRow({ calls, sessionId, touch = false, live = false }: {
  calls: ToolCall[];
  sessionId?: string;
  /** Mobile transcript: finger-sized row, no hover state, debug inspection always reachable. */
  touch?: boolean;
  /** The run is what the agent is doing right now: its line ends with the step under way. */
  live?: boolean;
}): JSX.Element {
  const L = useVocab();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const { selected, clear, inspect } = useCallInspect(sessionId);
  const line = runLine(calls, live, L);
  const collapse = (): void => { setExpanded(false); buttonRef.current?.focus(); };
  const entry = useEntryAnimation('cxrise .24s cubic-bezier(.22,1,.36,1) both');
  return (
    <div data-tool-calls data-tool-live={live ? 'true' : undefined} style={{ display: 'flex', flexDirection: 'column', minWidth: 0, animation: entry }}>
      <button ref={buttonRef} type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
        className={`${MENU_FOCUS}${touch ? '' : ' hover:bg-[var(--proto-gray)]'}`} style={eventRowStyle(touch, true)}>
        <span style={iconBoxStyle}><EventIcon name={expanded ? 'chevron' : line.icon} open={expanded} /></span>
        <RunLineText line={line} />
      </button>
      <Collapse open={expanded}>
        <div data-tool-calls-panel onClick={collapse} style={panelStyle}>
          {calls.map((call, index) => <OpenCall key={index} call={call} touch={touch} onInspect={inspect} />)}
        </div>
      </Collapse>
      {expanded ? <DebugDetailsModal detail={selected} onClose={clear} /> : null}
    </div>
  );
}
