// input:  session groups, DTOs, and list callbacks
// output: fixed-header Sessions tab presentation
// pos:    Presentational mobile session-list screen
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1a L86-128)
import { MScreen, MTabHeader, MScrollBody, MCard, MGroupLabel, MDot, MC, MONO } from '@/mobile/ui/kit';
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

// The Scheduled entry (scheme-mobile 8a): a 34px clock circle left of ＋; unread schedules ride
// as a badge (blue — failed runs have no data source, so the badge never turns red here).
function ScheduledButton({ unread, onClick }: { unread: number; onClick: () => void }) {
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        aria-label="Scheduled"
        onClick={onClick}
        style={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          background: MC.card,
          border: `1px solid ${MC.hairline}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <svg width={16} height={16} viewBox="0 0 14 14" fill="none" stroke={MC.sub} strokeWidth={1.5}>
          <circle cx="7" cy="7" r="5.6" />
          <path d="M7 4v3.2l2.2 1.3" />
        </svg>
      </button>
      {unread > 0 && (
        <span
          aria-label={`${unread} unread scheduled`}
          style={{
            position: 'absolute',
            top: -3,
            right: -4,
            background: MC.run,
            color: 'var(--ink-solid-fg)',
            font: `600 8.5px ${MONO}`,
            padding: '1px 4.5px',
            borderRadius: 999,
            border: `1.5px solid ${MC.canvas}`,
          }}
        >
          {unread}
        </span>
      )}
    </div>
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
        {/* Background-held now reads as run-blue (same as running) — a bg task is not a user action. */}
        {status.kind === 'background' && <MDot color={MC.run} pulse />}
        {/* Amber is reserved for「需要你」— a pending ask-user question / plan approval. */}
        {status.kind === 'awaiting' && <MDot color={MC.amber} pulse />}
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
  scheduled,
  onOpen,
  onNew,
}: {
  groups: MSessionGroup[];
  sessions: SessionInfo[];
  scope?: string;
  copy: MSessionListCopy;
  /** Scheduled entry (8a): hidden while the project has no schedules and no runs. */
  scheduled?: { unread: number; onOpen: () => void };
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  return (
    <MScreen
      label="1a 会话列表"
      header={
        <MTabHeader
          title={copy.title}
          qn={scope}
          trailing={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {scheduled && <ScheduledButton unread={scheduled.unread} onClick={scheduled.onOpen} />}
              <NewButton onClick={onNew} />
            </div>
          }
        />
      }
    >
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
    </MScreen>
  );
}
