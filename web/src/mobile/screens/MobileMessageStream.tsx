// @ds-adherence-ignore -- mobile chat stream, 1:1 from scheme.dc.html L2946-2952 (raw px/hex/font by
// design, §8.3; mobile palette is not in the light `proto.*` token set).
import { Fragment, useState } from 'react';
import type { ChatRow } from '@/features/workbench/transcript-vm';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import { toolChips } from './mobile-session-vm';

const mono = "'IBM Plex Mono',monospace";

function Divider({ text }: { text: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, height: 1, background: '#E3E5EA' }} />
      <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.06em', color: '#B6BDC9' }}>{text}</div>
      <div style={{ flex: 1, height: 1, background: '#E3E5EA' }} />
    </div>
  );
}

function UserBubble({ text }: { text: string }): JSX.Element {
  return (
    <div
      style={{
        alignSelf: 'flex-end',
        maxWidth: '82%',
        background: '#191C22',
        color: '#fff',
        borderRadius: '16px 16px 4px 16px',
        padding: '9px 13px',
        fontSize: 13.5,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  );
}

// Collapsed/expanded tool-call row. Collapsed: "N 工具调用" + the first tool-name chips; tapping
// expands to the per-call kind + input rows (mirrors the desktop ToolCallsRow). The whole row is a
// tap target (≥ the surrounding chips) so it works on touch.
function ToolCallsRow({
  count,
  calls,
  unit,
}: {
  count: number;
  calls: { kind: string; input: string }[];
  unit: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const chips = toolChips(calls);

  if (!expanded) {
    return (
      <div
        onClick={() => setExpanded(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: '#98A1B0',
          flexWrap: 'wrap',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 8.5 }}>▸</span>
        <span>
          {count} {unit}
        </span>
        {chips.names.map((name, i) => (
          <span
            key={i}
            style={{
              font: `400 10px ${mono}`,
              background: '#fff',
              border: '1px solid #EFF1F5',
              padding: '1px 6px',
              borderRadius: 4,
            }}
          >
            {name}
          </span>
        ))}
        {chips.overflow > 0 && <span>+{chips.overflow}</span>}
      </div>
    );
  }

  return (
    <div
      style={{
        background: '#FBFBFC',
        border: '1px solid #EFF1F5',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        onClick={() => setExpanded(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: '#98A1B0',
          padding: '6px 11px',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 8.5 }}>▾</span>
        <span>
          {count} {unit}
        </span>
      </div>
      {calls.map((c, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5.5px 11px',
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
              minWidth: 0,
            }}
          >
            {c.input}
          </span>
        </div>
      ))}
    </div>
  );
}

function AssistantBlock({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  // Rich Markdown (headings/lists/code/inline bold·italic·code·links/table) via the shared chat
  // renderer — replaces the former raw-text block that dropped every line break and format.
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.65, color: '#22262E', minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
      <ChatMarkdown text={text} />
      {streaming && (
        <span
          style={{
            display: 'inline-block',
            width: 7,
            height: 14,
            marginLeft: 2,
            verticalAlign: 'text-bottom',
            background: '#4655D4',
            animation: 'cxblink 1.1s steps(1) infinite',
          }}
        />
      )}
    </div>
  );
}

export function MobileMessageStream({ rows, toolCallsUnit }: { rows: ChatRow[]; toolCallsUnit: string }): JSX.Element {
  return (
    <>
      {rows.map((row, i) => (
        <Fragment key={i}>
          {row.kind === 'divider' && <Divider text={row.text} />}
          {row.kind === 'user' && <UserBubble text={row.text} />}
          {row.kind === 'tools' && <ToolCallsRow count={row.count} calls={row.calls} unit={toolCallsUnit} />}
          {row.kind === 'assistant' && <AssistantBlock text={row.text} streaming={row.streaming} />}
        </Fragment>
      ))}
    </>
  );
}
