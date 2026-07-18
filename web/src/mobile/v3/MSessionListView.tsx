// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1a L86-128)
import { MTabHeader, MScrollBody, MCard, MGroupLabel, MDot, MC, MONO } from '@/mobile/ui/kit';
import { sessionStatusLine, type MSessionGroup } from './m-session-list-vm';
import type { SessionInfo } from '@cortex-agent/ui-contract';

export interface MSessionListCopy {
  title: string;
  today: string;
  yesterday: string;
  earlier: string;
  empty: string;
}

function groupLabel(copy: MSessionListCopy, key: MSessionGroup['key']): string {
  return key === 'TODAY' ? copy.today : key === 'YESTERDAY' ? copy.yesterday : copy.earlier;
}

// The ＋ new-session button (scheme 1a L94): 34px ink circle.
function NewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="New session"
      onClick={onClick}
      style={{
        width: 34,
        height: 34,
        borderRadius: '50%',
        background: MC.ink,
        border: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--ink-solid-fg)',
        fontSize: 17,
        fontWeight: 400,
        cursor: 'pointer',
      }}
    >
      ＋
    </button>
  );
}

function Row({ row, byId, onOpen }: { row: MSessionGroup['rows'][number]; byId: Map<string, SessionInfo>; onOpen: (id: string) => void }) {
  const s = byId.get(row.id);
  const status = s ? sessionStatusLine(s) : { kind: 'idle' as const, text: '空闲' };
  return (
    <MCard radius={12} padding="12px 13px" onClick={() => onOpen(row.id)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {/* Unread marker (honest addition, mirrors desktop LeftRail): an accent dot leads unread
            rows and their title keeps full ink + semibold, while read rows soften — so unread reads
            darker at a glance. Cleared by useMarkSessionRead once the chat is opened. */}
        {row.unread && (
          <span
            aria-label="unread"
            style={{ width: 7, height: 7, borderRadius: '50%', background: MC.run, flex: 'none' }}
          />
        )}
        <span
          style={{
            fontSize: 14,
            fontWeight: row.unread ? 600 : 400,
            color: row.unread ? MC.ink : 'var(--proto-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {row.title}
        </span>
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint, flex: 'none' }}>
          {row.time}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
        {status.kind === 'running' && <MDot color={MC.run} pulse />}
        {status.kind === 'background' && <MDot color={MC.amber} pulse />}
        <span style={{ font: `400 10px ${MONO}`, color: MC.muted }}>{status.text}</span>
      </div>
    </MCard>
  );
}

export function MSessionListView({
  groups,
  sessions,
  scope,
  copy,
  onOpen,
  onNew,
}: {
  groups: MSessionGroup[];
  sessions: SessionInfo[];
  scope?: string;
  copy: MSessionListCopy;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  return (
    <>
      <MTabHeader title={copy.title} qn={scope} trailing={<NewButton onClick={onNew} />} />
      <MScrollBody gap={6}>
        {groups.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>
            {copy.empty}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <MGroupLabel style={{ padding: '6px 2px 2px' }}>{groupLabel(copy, g.key)}</MGroupLabel>
            {g.rows.map((row) => (
              <Row key={row.id} row={row} byId={byId} onOpen={onOpen} />
            ))}
          </div>
        ))}
      </MScrollBody>
    </>
  );
}
