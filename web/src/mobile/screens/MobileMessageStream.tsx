// @ds-adherence-ignore -- mobile chat stream, 1:1 from scheme.dc.html L2946-2952 (raw px/hex/font by
// design, §8.3; mobile palette is not in the light `proto.*` token set).
import { Fragment } from 'react';
import type { ChatRow } from '@/features/workbench/transcript-vm';
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
      }}
    >
      {text}
    </div>
  );
}

function ToolCallsRow({
  count,
  calls,
  unit,
}: {
  count: number;
  calls: { kind: string; input: string }[];
  unit: string;
}): JSX.Element {
  const chips = toolChips(calls);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        color: '#98A1B0',
        flexWrap: 'wrap',
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

function AssistantBlock({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.65, color: '#22262E' }}>
      {text}
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
