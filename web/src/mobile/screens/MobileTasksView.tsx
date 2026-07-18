// @ds-adherence-ignore -- mobile 5c 任务 screen, 1:1 from scheme.dc.html L3110-3186 (raw px/hex/font
// by design, §8.3 原始值优先; the mobile palette is not in the light `proto.*` token set).
//
// Presentational only — props-driven so it is render-testable without tRPC providers. The container
// (MobileTasksScreen) binds real `tasks.list` + `tasks.unblock` and owns segment/expanded state.
// The bottom Tab is shell-owned (MobileShell) and intentionally NOT rendered here.
import { type CSSProperties } from 'react';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { type Vocab } from '@/i18n';
import {
  type MobileGroupView,
  type MobileSegment,
  type MobileTaskGroup,
  MOBILE_GROUP_DOT,
} from '../mobile-tasks';

const MONO = "'IBM Plex Mono',monospace";

function groupLabel(vocab: Vocab, group: MobileTaskGroup): string {
  switch (group) {
    case 'in-progress':
      return vocab.mInProgress;
    case 'claimable':
      return vocab.mClaimable;
    case 'waiting-deps':
      return vocab.mWaitingDeps;
    case 'blocked':
      return vocab.mBlocked;
  }
}

function Dot({ color }: { color: string }) {
  return (
    <span
      style={{ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none', marginTop: 5 }}
    />
  );
}

function TitleRow({
  chevron,
  chevronColor,
  task,
}: {
  chevron: string;
  chevronColor: string;
  task: TaskInfo;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ color: chevronColor, fontSize: 8.5, flex: 'none' }}>{chevron}</span>
      <span style={{ font: `500 10px ${MONO}`, color: 'var(--proto-muted-3)' }}>{task.id}</span>
      <span style={{ fontSize: 12.5, color: 'var(--proto-ink-2)', lineHeight: 1.45 }}>{task.text}</span>
    </div>
  );
}

const CARD_BASE: CSSProperties = {
  background: 'var(--proto-card)',
  borderRadius: 11,
  padding: '10px 13px',
};

function InProgressCard({ task, vocab }: { task: TaskInfo; vocab: Vocab }) {
  return (
    <div style={{ ...CARD_BASE, border: '1px solid var(--proto-line)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Dot color={MOBILE_GROUP_DOT['in-progress']} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <TitleRow chevron="▸" chevronColor="var(--proto-faint)" task={task} />
          {task.claimedBy && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
              <span
                style={{
                  font: `500 9.5px ${MONO}`,
                  color: 'var(--proto-accent)',
                  background: 'var(--proto-accent-bg)',
                  padding: '2px 7px',
                  borderRadius: 999,
                }}
              >
                {vocab.mClaim} · {task.claimedBy}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ClaimableCard({
  task,
  vocab,
  expanded,
  onToggle,
}: {
  task: TaskInfo;
  vocab: Vocab;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      style={{
        ...CARD_BASE,
        cursor: 'pointer',
        border: expanded ? '1px solid var(--proto-accent-border)' : '1px solid var(--proto-line)',
        boxShadow: expanded ? '0 1px 3px rgba(70,85,212,.08)' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Dot color={expanded ? 'var(--proto-amber)' : 'var(--proto-faint)'} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <TitleRow
            chevron={expanded ? '▾' : '▸'}
            chevronColor={expanded ? 'var(--proto-muted)' : 'var(--proto-faint)'}
            task={task}
          />
          <div style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)', marginTop: 5 }}>
            {task.priority} · {task.template}
          </div>
          {expanded && (
            <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--proto-line-soft)' }}>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '.06em',
                  color: 'var(--proto-faint)',
                  marginBottom: 5,
                }}
              >
                {vocab.mDoneWhen}
              </div>
              {/* Real `doneWhen` (task store done-when) when present; honest placeholder when the
                  task has none (null-safe, no fabrication — 守则11). */}
              {task.doneWhen != null ? (
                <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--proto-ink-2)' }}>
                  {task.doneWhen}
                </div>
              ) : (
                <div
                  style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--proto-muted-2)', fontStyle: 'italic' }}
                >
                  {vocab.mDoneWhenGap}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WaitingDepsCard({ task, vocab }: { task: TaskInfo; vocab: Vocab }) {
  return (
    <div style={{ ...CARD_BASE, border: '1px solid var(--proto-line)', opacity: 0.82 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Dot color={MOBILE_GROUP_DOT['waiting-deps']} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <TitleRow chevron="▸" chevronColor="var(--proto-faint)" task={task} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5, flexWrap: 'wrap' }}>
            {task.dependsOn.map((dep) => (
              <span
                key={dep}
                style={{
                  font: `500 9.5px ${MONO}`,
                  color: 'var(--proto-muted-2)',
                  background: 'var(--proto-gray)',
                  padding: '2px 7px',
                  borderRadius: 999,
                }}
              >
                {vocab.mDependsOn} {dep}
              </span>
            ))}
            <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>{vocab.mAutoUnlock}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function BlockedCard({
  task,
  vocab,
  pending,
  onUnblock,
}: {
  task: TaskInfo;
  vocab: Vocab;
  pending: boolean;
  onUnblock: (t: TaskInfo) => void;
}) {
  return (
    <div style={{ ...CARD_BASE, border: '1px solid var(--proto-danger-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Dot color={MOBILE_GROUP_DOT.blocked} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <TitleRow chevron="▸" chevronColor="var(--proto-faint)" task={task} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
            <span
              style={{
                font: `500 9.5px ${MONO}`,
                color: 'var(--proto-danger)',
                background: 'var(--proto-danger-bg)',
                padding: '2px 7px',
                borderRadius: 999,
              }}
            >
              {vocab.mBlockedPill}
            </span>
            {task.blockedBy && (
              <span style={{ fontSize: 10, color: 'var(--proto-amber-fg)' }}>{task.blockedBy}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => onUnblock(task)}
          style={{
            // scheme text style; ≥44px touch target (触屏适配 per scheme note L3198)
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--proto-accent)',
            flex: 'none',
            background: 'none',
            border: 'none',
            cursor: pending ? 'default' : 'pointer',
            opacity: pending ? 0.5 : 1,
            minWidth: 44,
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '4px 0 4px 8px',
          }}
        >
          {vocab.mUnblock}
        </button>
      </div>
    </div>
  );
}

function GroupCards({
  view,
  vocab,
  expandedIds,
  onToggleExpand,
  pendingId,
  onUnblock,
}: {
  view: MobileGroupView;
  vocab: Vocab;
  expandedIds: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  pendingId: string | null;
  onUnblock: (t: TaskInfo) => void;
}) {
  return (
    <>
      {view.tasks.map((task) => {
        switch (view.group) {
          case 'in-progress':
            return <InProgressCard key={task.id} task={task} vocab={vocab} />;
          case 'claimable':
            return (
              <ClaimableCard
                key={task.id}
                task={task}
                vocab={vocab}
                expanded={expandedIds.has(task.id)}
                onToggle={() => onToggleExpand(task.id)}
              />
            );
          case 'waiting-deps':
            return <WaitingDepsCard key={task.id} task={task} vocab={vocab} />;
          case 'blocked':
            return (
              <BlockedCard
                key={task.id}
                task={task}
                vocab={vocab}
                pending={pendingId === task.id}
                onUnblock={onUnblock}
              />
            );
        }
      })}
    </>
  );
}

export interface MobileTasksViewProps {
  vocab: Vocab;
  groups: MobileGroupView[];
  segment: MobileSegment;
  executableCount: number;
  allCount: number;
  onSegment: (s: MobileSegment) => void;
  expandedIds: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  pendingId: string | null;
  onUnblock: (t: TaskInfo) => void;
  empty?: string;
}

export function MobileTasksView({
  vocab,
  groups,
  segment,
  executableCount,
  allCount,
  onSegment,
  expandedIds,
  onToggleExpand,
  pendingId,
  onUnblock,
  empty,
}: MobileTasksViewProps) {
  const segStyle = (active: boolean): CSSProperties =>
    active
      ? {
          fontSize: 11.5,
          fontWeight: 600,
          color: 'var(--proto-ink)',
          background: 'var(--proto-card)',
          borderRadius: 6,
          padding: '4px 12px',
          boxShadow: '0 1px 2px rgba(16,24,40,.06)',
          border: 'none',
          cursor: 'pointer',
        }
      : {
          fontSize: 11.5,
          fontWeight: 600,
          color: 'var(--proto-muted-2)',
          padding: '4px 12px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
        };

  return (
    <div
      data-screen-label="5c"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top)',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '6px 14px 10px',
          borderBottom: '1px solid var(--proto-line)',
          background: 'var(--proto-alt)',
        }}
      >
        <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--proto-ink)', letterSpacing: '-.02em' }}>
          {vocab.tasks}
        </span>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            background: 'var(--proto-line)',
            borderRadius: 8,
            padding: 2,
          }}
        >
          <button type="button" style={segStyle(segment === 'executable')} onClick={() => onSegment('executable')}>
            {vocab.mExecutable} {executableCount}
          </button>
          <button type="button" style={segStyle(segment === 'all')} onClick={() => onSegment('all')}>
            {vocab.mAll} {allCount}
          </button>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 14px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          background: 'var(--proto-alt)',
        }}
      >
        {groups.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--proto-muted-2)', padding: '8px 2px' }}>{empty}</div>
        ) : (
          groups.map((view, i) => (
            <div key={view.group} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: '.07em',
                  color: 'var(--proto-faint)',
                  padding: i === 0 ? '0 2px 2px' : '8px 2px 2px',
                }}
              >
                {groupLabel(vocab, view.group)} · {view.tasks.length}
              </div>
              <GroupCards
                view={view}
                vocab={vocab}
                expandedIds={expandedIds}
                onToggleExpand={onToggleExpand}
                pendingId={pendingId}
                onUnblock={onUnblock}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
