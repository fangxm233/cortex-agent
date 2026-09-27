// Workbench-local UI words that have no shared vocab key. Selected by lang so the hook-free
// view-models (right-panel-vm, inline-thread-card-vm) can use them too. `{i}` / `{n}` are filled by
// the caller with String.replace.
import type { Lang } from '@/i18n';

const WB_COPY_EN = {
  actOpen: 'Open',
  machineOnline: 'Online',
  machineOffline: 'Offline',
  pauseUnavailable: 'Pausing a thread is not supported yet',
  metaRunning: 'running',
  metaDone: 'done',
  metaGated: 'gated',
  metaStep: 'step {i}/{n}',
  pillStep: 'Step {i}/{n}',
  openWebPage: 'Open a web page in the dock',
  sessionMenu: 'Session menu',
  noSession: 'No session',
  attachQueued: 'queued',
  attachRetry: 'retry',
  runCaption: 'RUN',
  firedCaption: 'FIRED',
  costCaption: 'COST',
};

export type WorkbenchCopy = typeof WB_COPY_EN;

const WB_COPY: Record<Lang, WorkbenchCopy> = {
  en: WB_COPY_EN,
  zh: {
    actOpen: '可执行',
    machineOnline: '在线',
    machineOffline: '离线',
    pauseUnavailable: '暂不支持暂停线程',
    metaRunning: '运行中',
    metaDone: '完成',
    metaGated: '等审批',
    metaStep: '步骤 {i}/{n}',
    pillStep: '步骤 {i}/{n}',
    openWebPage: '在停靠面板中打开网页',
    sessionMenu: '会话菜单',
    noSession: '无会话',
    attachQueued: '排队中',
    attachRetry: '重试',
    runCaption: '运行',
    firedCaption: '触发',
    costCaption: '费用',
  },
};

export function workbenchCopy(lang: Lang): WorkbenchCopy {
  return WB_COPY[lang];
}

/** Fill a `{i}/{n}` step template, e.g. "Step 2/4" / "步骤 2/4". */
export function fillStep(template: string, i: number, n: number): string {
  return template.replace('{i}', String(i)).replace('{n}', String(n));
}
