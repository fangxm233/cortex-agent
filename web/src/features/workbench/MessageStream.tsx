import { Fragment } from 'react';
import { REPRESENTATIVE_APPROVAL } from './chat-content';
import type { ChatRow } from './transcript-vm';
import { ToolCallsRow } from './ToolCallsRow';
import { InlineThreadCardProto } from './InlineThreadCardProto';
import { ApprovalCard } from './ApprovalCard';
import { ChatMarkdown } from './ChatMarkdown';

// Message stream — 1:1 from prototype.dc.html L131–357. The transcript body (divider / user bubble /
// tool-call row / assistant text) is now driven by REAL data (task aba0): the `rows` are built from
// the real `sessions.transcript` query + live `session.message` stream by the pure transcript-vm; the
// last assistant row streams a caret while output is live. Real data is the only variable — every
// px/hex/font/copy is the prototype's. Kept 1:1 surfaces: the live inline thread card (threads.get)
// and the representative approval card (Stage-5 GAP-B, no approvals scope — flagged).

const mono = "'IBM Plex Mono',monospace";

function Divider({ text }: { text: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1, height: 1, background: '#EFF1F5' }} />
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: '#B6BDC9' }}>{text}</div>
      <div style={{ flex: 1, height: 1, background: '#EFF1F5' }} />
    </div>
  );
}

function UserBubble({ text }: { text: string }): JSX.Element {
  return (
    <div
      style={{
        alignSelf: 'flex-end',
        maxWidth: '75%',
        animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both',
        background: '#F1F2F5',
        borderRadius: '14px 14px 4px 14px',
        padding: '9px 14px',
        fontSize: 13.5,
        lineHeight: 1.55,
        color: '#191C22',
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </div>
  );
}

function AssistantBlock({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  return (
    <div style={{ animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both', fontSize: 14, lineHeight: 1.65, color: '#22262E' }}>
      <ChatMarkdown text={text} />
      {streaming && (
        <span
          style={{
            display: 'inline-block',
            width: 7,
            height: 15,
            background: '#4655D4',
            borderRadius: 1.5,
            marginLeft: 3,
            verticalAlign: -2,
            animation: 'cxblink 1.1s steps(1) infinite',
          }}
        />
      )}
    </div>
  );
}

// Empty session — 1:1 from prototype.dc.html L133–143 (chatEmpty). EN copy verbatim from support.js.
function EmptyChat(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 13, padding: '88px 20px 40px', textAlign: 'center' }}>
      <div style={{ width: 40, height: 40, borderRadius: 12, background: '#191C22', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `600 15px ${mono}` }}>cx</div>
      <div style={{ fontSize: 15, fontWeight: 650, color: '#191C22' }}>Start with one message</div>
      <div style={{ fontSize: 12, color: '#8A93A2', lineHeight: 1.7, maxWidth: 420 }}>
        This project is empty. Just chat — describe the mission and the agent runs project_init (mission.md · TASKS.yaml · memory scaffold · git).
      </div>
      <div style={{ fontSize: 10.5, color: '#B6BDC9', lineHeight: 1.7, maxWidth: 430 }}>
        Everything else — tasks, threads, cross-machine runs — starts from this chat
      </div>
    </div>
  );
}

function Row({ row }: { row: ChatRow }): JSX.Element | null {
  switch (row.kind) {
    case 'divider':
      return <Divider text={row.text} />;
    case 'user':
      return <UserBubble text={row.text} />;
    case 'tools':
      return <ToolCallsRow calls={row.calls.map((c) => ({ label: c.kind, kind: c.kind, input: c.input }))} />;
    case 'assistant':
      return <AssistantBlock text={row.text} streaming={row.streaming} />;
    default:
      return null;
  }
}

export function MessageStream({ rows, loading }: { rows: ChatRow[]; loading: boolean }): JSX.Element {
  const populated = rows.length > 0;
  return (
    <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '22px 32px 12px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!populated && !loading && <EmptyChat />}
        {rows.map((row, i) => (
          <Row key={i} row={row} />
        ))}
        {populated && (
          <Fragment>
            <InlineThreadCardProto />
            <ApprovalCard approval={REPRESENTATIVE_APPROVAL} />
          </Fragment>
        )}
      </div>
    </div>
  );
}
