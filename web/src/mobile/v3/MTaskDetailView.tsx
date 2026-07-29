// input:  Task detail model, copy, navigation callbacks
// output: Read-only mobile task detail screen
// pos:    Presentational view for mobile task details
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1h L440-484)
// Presentational view for the 1h 任务详情 drill page. Pure — takes a built MTaskDetailVm + a copy
// table + nav callbacks. Every px/hex/font is lifted 1:1 from the scheme's inner data-screen-label
// div (the iOS frame / status-bar / island / home-indicator wrapper is ignored per the brief).
import type { CSSProperties, ReactNode } from 'react';
import {
  MScreen,
  MScrollBody,
  MDrillHeader,
  MCard,
  MPill,
  type PillTone,
  MC,
  MONO,
} from '@/mobile/ui/kit';
import { relTimeZh } from '@/mobile/ui/format';
import type {
  MTaskDetailVm,
  MTaskStatusKind,
  MTaskHistoryRowVm,
} from './m-task-detail-vm';
import type { TaskInfo, TaskDispatchRecord } from '@cortex-agent/ui-contract';

export interface MTaskDetailCopy {
  tasksTag: string;
  doneWhen: string;
  doneWhenGap: string;
  claimPrefix: string;
  open: string;
  priorityLabel: string;
  statusLabel: string;
  templateLabel: string;
  depsLabel: string;
  depsEmpty: string;
  historyLabel: string;
  historyEmpty: string;
  footer: string;
  notFound: string;
  status: Record<MTaskStatusKind, string>;
  priority: Record<TaskInfo['priority'], string>;
  dispatchStatus: Record<TaskDispatchRecord['status'], string>;
  dispatchType: Record<TaskDispatchRecord['type'], string>;
}

export const ZH_COPY: MTaskDetailCopy = {
  tasksTag: 'tasks.json',
  doneWhen: 'DONE-WHEN',
  doneWhenGap: 'done-when 未记录',
  claimPrefix: '认领',
  open: '打开 ›',
  priorityLabel: '优先级',
  statusLabel: '状态',
  templateLabel: '模板',
  depsLabel: '依赖',
  depsEmpty: '无依赖',
  historyLabel: '历史',
  historyEmpty: '暂无派发历史',
  footer: '只读 — 编辑 / 派发 / 取消在桌面或对话内完成',
  notFound: '任务未找到',
  status: { 'in-progress': '进行中', actionable: '可执行', blocked: '阻塞', done: '完成', waiting: '等待' },
  priority: { high: 'P高', medium: 'P中', low: 'P低' },
  dispatchStatus: { running: '运行中', completed: '完成', failed: '失败', cancelled: '已取消', stale: '停滞' },
  dispatchType: { local: '本地', dispatch: '派发' },
};

export const EN_COPY: MTaskDetailCopy = {
  tasksTag: 'tasks.json',
  doneWhen: 'DONE-WHEN',
  doneWhenGap: 'no done-when recorded',
  claimPrefix: 'claimed',
  open: 'open ›',
  priorityLabel: 'Priority',
  statusLabel: 'Status',
  templateLabel: 'Template',
  depsLabel: 'Depends',
  depsEmpty: 'No dependencies',
  historyLabel: 'History',
  historyEmpty: 'No dispatch history',
  footer: 'Read-only — edit / dispatch / cancel on desktop or in chat',
  notFound: 'Task not found',
  status: { 'in-progress': 'In progress', actionable: 'Executable', blocked: 'Blocked', done: 'Done', waiting: 'Waiting' },
  priority: { high: 'High', medium: 'Med', low: 'Low' },
  dispatchStatus: { running: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled', stale: 'stale' },
  dispatchType: { local: 'local', dispatch: 'dispatch' },
};

const PILL_TONE: Record<MTaskStatusKind, PillTone> = {
  'in-progress': 'running',
  actionable: 'running',
  blocked: 'failed',
  done: 'done',
  waiting: 'waiting',
};

// A dependency's status text color, keyed by its own derived kind (scheme dep line = amber var(--proto-amber-text)).
const DEP_COLOR: Record<MTaskStatusKind, string> = {
  'in-progress': MC.run,
  actionable: MC.run,
  blocked: MC.fail,
  done: MC.done,
  waiting: MC.amberText,
};

// ── the claim-line thread glyph (scheme L459: 13×13, stroke var(--proto-accent), sw 1.6) ──
function ThreadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke={MC.run} strokeWidth="1.6" style={{ flex: 'none' }}>
      <circle cx="3.5" cy="3" r="1.9" />
      <circle cx="3.5" cy="11" r="1.9" />
      <circle cx="10.5" cy="7" r="1.9" />
      <path d="M3.5 5v4M5.4 3.7 8.7 6.1M5.4 10.3 8.7 7.9" />
    </svg>
  );
}

const rowBase: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, padding: '10px 13px' };

export function MTaskDetailView({
  vm,
  copy,
  onBack,
  onOpenThread,
}: {
  vm: MTaskDetailVm;
  copy: MTaskDetailCopy;
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  if (!vm.found) {
    return (
      <MScreen
        label="1h 任务详情"
        header={<MDrillHeader onBack={onBack}><span style={{ font: `600 15px ${MONO}`, color: MC.ink }}>—</span></MDrillHeader>}
      >
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.notFound}</div>
      </MScreen>
    );
  }

  const header = (
    <MDrillHeader
      onBack={onBack}
      trailing={<span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>{copy.tasksTag}</span>}
    >
      <span style={{ font: `600 15px ${MONO}`, color: MC.ink, flex: 'none' }}>{vm.displayId}</span>
      <MPill tone={PILL_TONE[vm.statusKind]}>{copy.status[vm.statusKind]}</MPill>
    </MDrillHeader>
  );

  const fieldRows: Array<{ key: string; node: ReactNode }> = [
    {
      key: 'priority',
      node: (
        <>
          <span style={{ fontSize: 12, color: MC.muted, width: 62, flex: 'none' }}>{copy.priorityLabel}</span>
          <span style={{ fontSize: 12, color: MC.body, fontWeight: 600 }}>{copy.priority[vm.priority]}</span>
        </>
      ),
    },
    {
      key: 'status',
      node: (
        <>
          <span style={{ fontSize: 12, color: MC.muted, width: 62, flex: 'none' }}>{copy.statusLabel}</span>
          <span style={{ font: `500 11px ${MONO}`, color: MC.body }}>{vm.status}</span>
        </>
      ),
    },
    {
      key: 'template',
      node: (
        <>
          <span style={{ fontSize: 12, color: MC.muted, width: 62, flex: 'none' }}>{copy.templateLabel}</span>
          <span style={{ font: `500 11px ${MONO}`, color: MC.body, overflowWrap: 'anywhere' }}>{vm.template}</span>
        </>
      ),
    },
    {
      key: 'deps',
      node: (
        <>
          <span style={{ fontSize: 12, color: MC.muted, width: 62, flex: 'none' }}>{copy.depsLabel}</span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            {vm.deps.length === 0 ? (
              <span style={{ fontSize: 11, color: MC.faint }}>{copy.depsEmpty}</span>
            ) : vm.deps.map((d) => (
              <span key={d.id} style={{ font: `500 11px ${MONO}`, color: d.known ? DEP_COLOR[d.statusKind] : MC.faint }}>
                {d.displayId}
                {d.known ? ` · ${copy.status[d.statusKind]}` : ''}
              </span>
            ))}
          </span>
        </>
      ),
    },
  ];

  return (
    <MScreen label="1h 任务详情" header={header}>
      <MScrollBody gap={10}>
        {/* task text */}
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, lineHeight: 1.45, padding: '0 2px' }}>
          {vm.text}
        </div>

        {/* DONE-WHEN */}
        <MCard>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.07em', color: MC.faint }}>{copy.doneWhen}</div>
          <div
            style={{
              font: `400 11px/1.7 ${MONO}`,
              color: vm.doneWhen ? MC.sub : MC.faint,
              marginTop: 6,
              whiteSpace: 'pre-wrap',
            }}
          >
            {vm.doneWhen ?? copy.doneWhenGap}
          </div>
        </MCard>

        {/* claim-thread card (only when claimed) */}
        {vm.claim && (
          <MCard>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ThreadIcon />
              <span style={{ font: `600 12.5px ${MONO}`, color: MC.ink }}>{vm.claim.template}</span>
              <span style={{ font: `400 9.5px ${MONO}`, color: MC.muted }}>
                {copy.claimPrefix} · {vm.claim.threadId ?? vm.claim.claimedBy}
              </span>
              {vm.claim.threadId && (
                <span
                  onClick={() => onOpenThread(vm.claim!.threadId!)}
                  style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: MC.run, cursor: 'pointer', flex: 'none' }}
                >
                  {copy.open}
                </span>
              )}
            </div>
            {vm.claim.meta && (
              <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 4 }}>{vm.claim.meta}</div>
            )}
          </MCard>
        )}

        {/* fields card */}
        <MCard padding={0} style={{ overflow: 'hidden' }}>
          {fieldRows.map((r, i) => (
            <div
              key={r.key}
              style={{ ...rowBase, borderBottom: i < fieldRows.length - 1 ? `1px solid ${MC.divider}` : undefined }}
            >
              {r.node}
            </div>
          ))}
        </MCard>

        {/* 历史 card */}
        <MCard padding={0} style={{ overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '9px 13px', borderBottom: `1px solid var(--proto-line-2)` }}>
            <span style={{ fontSize: 12, fontWeight: 650, color: MC.ink }}>{copy.historyLabel}</span>
          </div>
          {vm.history.length === 0 ? (
            <div style={{ padding: '10px 13px', font: `400 10px ${MONO}`, color: MC.faint }}>{copy.historyEmpty}</div>
          ) : (
            <div style={{ padding: '9px 13px', display: 'flex', flexDirection: 'column', gap: 7, font: `400 10px/1.5 ${MONO}` }}>
              {vm.history.map((h, i) => (
                <HistoryRow key={i} h={h} copy={copy} />
              ))}
            </div>
          )}
        </MCard>

        {/* read-only footer */}
        <div style={{ font: `400 9.5px ${MONO}`, color: MC.faint, padding: '0 4px' }}>{copy.footer}</div>
      </MScrollBody>
    </MScreen>
  );
}

function HistoryRow({ h, copy }: { h: MTaskHistoryRowVm; copy: MTaskDetailCopy }) {
  const time = relTimeZh(h.startedAt);
  const event = `${copy.dispatchType[h.type]} · ${copy.dispatchStatus[h.status]}`;
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ color: MC.faint, flex: 'none' }}>{time}</span>
      <span style={{ color: MC.sub }}>
        {event}
        {h.isCompleting ? ' ✓' : ''}
      </span>
    </div>
  );
}
