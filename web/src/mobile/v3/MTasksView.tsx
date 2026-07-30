// input:  task groups, three segment counts, and callbacks
// output: fixed-header segmented Tasks presentation
// pos:    Presentational mobile task-list screen
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1d L240-284)
//
// 1d 任务 — read-only view of the current project's task queue. Presentational only, props-driven so
// it renders without tRPC providers (the container binds real `tasks.list` + owns segment/expand
// state). Three lifecycle groups (进行中 / 可执行 / 阻塞); waiting-deps tasks are counted in 全部 but
// have no row (see m-tasks-vm). The bottom Tab bar is shell-owned and intentionally not rendered here.
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { MScreen, MTabHeader, MScrollBody, MCard, MGroupLabel, MSegmented, MC, MONO } from '@/mobile/ui/kit';
import type { MTaskGroupKey, MTaskGroupView } from './m-tasks-vm';
import type { MobileSegment } from '@/mobile/mobile-tasks';

export interface MTasksCopy {
  title: string;
  executable: string; // 可执行 (segment)
  recent: string; // 近 1 天 (segment)
  all: string; // 全部 (segment)
  inProgress: string; // 进行中 (group)
  claimable: string; // 可执行 (group)
  blocked: string; // 阻塞 (group)
  claim: string; // 认领 (in-progress claim pill)
  doneWhen: string; // done-when: (box prefix)
  doneWhenGap: string; // honest placeholder when a task records no done-when
  waitApproval: string; // 等待审批
  seeApprovals: string; // 见项目页审批
  done: string; // 完成 (group)
  empty: string;
}

function groupLabel(copy: MTasksCopy, key: MTaskGroupKey): string {
  switch (key) {
    case 'in-progress':
      return copy.inProgress;
    case 'claimable':
      return copy.claimable;
    case 'blocked':
      return copy.blocked;
    case 'done':
      return copy.done;
  }
}

// Single-line task text with ellipsis truncation (parity with desktop TaskRow — the card's first
// line never wraps; overflow is cut with …).
const TEXT_TRUNCATE = {
  flex: 1,
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

// The mono T-id + task text baseline row shared by all three card kinds (scheme L256/261/272).
function IdText({ task, textColor }: { task: TaskInfo; textColor: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
      <span style={{ font: `500 10px ${MONO}`, color: MC.muted, flex: 'none' }}>{task.id}</span>
      <span style={{ fontSize: 12.5, color: textColor, lineHeight: 1.45, ...TEXT_TRUNCATE }} title={task.text}>
        {task.text}
      </span>
    </div>
  );
}

// 进行中 (scheme L255-258): id/text + a 认领 · <thr> › pill → thread. 步骤 N/M is a design mock —
// TaskInfo carries no step count → deliberately omitted (never fabricated). Whole card → task detail.
function InProgressCard({
  task,
  copy,
  onOpenTask,
  onOpenThread,
}: {
  task: TaskInfo;
  copy: MTasksCopy;
  onOpenTask: (id: string) => void;
  onOpenThread: (threadId: string) => void;
}) {
  return (
    <MCard radius={11} padding="10px 13px" onClick={() => onOpenTask(task.id)}>
      <IdText task={task} textColor={MC.body} />
      {task.claimedBy && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
          <span
            onClick={(e) => {
              e.stopPropagation();
              onOpenThread(task.claimedBy!);
            }}
            style={{
              font: `500 9.5px ${MONO}`,
              color: MC.run,
              background: MC.runBg,
              padding: '2px 7px',
              borderRadius: 999,
              cursor: 'pointer',
            }}
          >
            {copy.claim} · {task.claimedBy} ›
          </span>
        </div>
      )}
    </MCard>
  );
}

// 可执行 (scheme L260-266): id/text + ▾/▸ chevron; the chevron toggles a done-when box, the rest of
// the row → task detail. Real `doneWhen` in the mono box; honest gap string when the task has none.
function ClaimableCard({
  task,
  copy,
  expanded,
  onToggle,
  onOpenTask,
}: {
  task: TaskInfo;
  copy: MTasksCopy;
  expanded: boolean;
  onToggle: (id: string) => void;
  onOpenTask: (id: string) => void;
}) {
  return (
    <MCard radius={11} padding="10px 13px" onClick={() => onOpenTask(task.id)}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span style={{ font: `500 10px ${MONO}`, color: MC.muted, flex: 'none' }}>{task.id}</span>
        <span style={{ fontSize: 12.5, color: MC.body, lineHeight: 1.45, ...TEXT_TRUNCATE }} title={task.text}>
          {task.text}
        </span>
        <span
          role="button"
          aria-label="Toggle done-when"
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(task.id);
          }}
          style={{
            marginLeft: 'auto',
            color: MC.faint,
            fontSize: 8.5,
            flex: 'none',
            cursor: 'pointer',
            padding: '2px 2px 2px 8px',
          }}
        >
          {expanded ? '▾' : '▸'}
        </span>
      </div>
      {expanded && (
        <div
          style={{
            marginTop: 7,
            padding: '8px 10px',
            background: 'var(--proto-alt)',
            borderRadius: 8,
            font: `400 10px/1.6 ${MONO}`,
            color: MC.sub,
          }}
        >
          {copy.doneWhen}: {task.doneWhen ?? copy.doneWhenGap}
        </div>
      )}
    </MCard>
  );
}

// 阻塞 (scheme L271-274): dimmed card; an amber 等待审批 <ref> · 见项目页审批 line → approvals.
// Whole card → task detail. blockedBy is the real block ref.
function BlockedCard({
  task,
  copy,
  onOpenTask,
  onOpenApprovals,
}: {
  task: TaskInfo;
  copy: MTasksCopy;
  onOpenTask: (id: string) => void;
  onOpenApprovals: () => void;
}) {
  return (
    <MCard radius={11} padding="10px 13px" onClick={() => onOpenTask(task.id)} style={{ opacity: 0.75 }}>
      <IdText task={task} textColor={MC.sub} />
      <div
        onClick={(e) => {
          e.stopPropagation();
          onOpenApprovals();
        }}
        style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5, cursor: 'pointer' }}
      >
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: MC.amber, flex: 'none' }} />
        <span style={{ font: `400 9.5px ${MONO}`, color: MC.amberText }}>
          {copy.waitApproval}
          {task.blockedBy ? ` ${task.blockedBy}` : ''} · {copy.seeApprovals}
        </span>
      </div>
    </MCard>
  );
}

// 完成 (全部 segment only): a dimmed, read-only done card — green status dot + id/text. Whole card →
// task detail. Parity with desktop, which surfaces the done group in its 全部 scope.
function DoneCard({
  task,
  onOpenTask,
}: {
  task: TaskInfo;
  onOpenTask: (id: string) => void;
}) {
  return (
    <MCard radius={11} padding="10px 13px" onClick={() => onOpenTask(task.id)} style={{ opacity: 0.7 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: MC.done, flex: 'none' }} />
        <span style={{ font: `500 10px ${MONO}`, color: MC.muted, flex: 'none' }}>{task.id}</span>
        <span style={{ fontSize: 12.5, color: MC.sub, lineHeight: 1.45, ...TEXT_TRUNCATE }} title={task.text}>
          {task.text}
        </span>
      </div>
    </MCard>
  );
}

export function MTasksView({
  groups,
  segment,
  executableCount,
  recentCount,
  allCount,
  scope,
  copy,
  expandedIds,
  onToggleExpand,
  onSegment,
  onOpenTask,
  onOpenThread,
  onOpenApprovals,
}: {
  groups: MTaskGroupView[];
  segment: MobileSegment;
  executableCount: number;
  recentCount: number;
  allCount: number;
  scope?: string;
  copy: MTasksCopy;
  expandedIds: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  onSegment: (s: MobileSegment) => void;
  onOpenTask: (id: string) => void;
  onOpenThread: (threadId: string) => void;
  onOpenApprovals: () => void;
}) {
  const segmented = (
    <MSegmented<MobileSegment>
      options={[
        { id: 'executable', label: `${copy.executable} ${executableCount}` },
        { id: 'recent', label: `${copy.recent} ${recentCount}` },
        { id: 'all', label: `${copy.all} ${allCount}` },
      ]}
      value={segment}
      onChange={onSegment}
    />
  );

  return (
    <MScreen
      label="1d 任务"
      header={<MTabHeader title={copy.title} qn={scope} trailing={segmented} />}
    >
      <MScrollBody gap={6}>
        {groups.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>
            {copy.empty}
          </div>
        )}
        {groups.map((g, i) => (
          <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <MGroupLabel style={{ padding: i === 0 ? '0 2px 2px' : '6px 2px 2px' }}>
              {groupLabel(copy, g.key)} · {g.tasks.length}
            </MGroupLabel>
            {g.tasks.map((task) => {
              switch (g.key) {
                case 'in-progress':
                  return (
                    <InProgressCard
                      key={task.id}
                      task={task}
                      copy={copy}
                      onOpenTask={onOpenTask}
                      onOpenThread={onOpenThread}
                    />
                  );
                case 'claimable':
                  return (
                    <ClaimableCard
                      key={task.id}
                      task={task}
                      copy={copy}
                      expanded={expandedIds.has(task.id)}
                      onToggle={onToggleExpand}
                      onOpenTask={onOpenTask}
                    />
                  );
                case 'blocked':
                  return (
                    <BlockedCard
                      key={task.id}
                      task={task}
                      copy={copy}
                      onOpenTask={onOpenTask}
                      onOpenApprovals={onOpenApprovals}
                    />
                  );
                case 'done':
                  return <DoneCard key={task.id} task={task} onOpenTask={onOpenTask} />;
              }
            })}
          </div>
        ))}
      </MScrollBody>
    </MScreen>
  );
}
