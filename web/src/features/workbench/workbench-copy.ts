// Workbench-local UI words that have no shared vocab key. Selected by lang so the hook-free
// view-models (e.g. right-panel-vm) can use them too.
import type { Lang } from '@/i18n';

const WB_COPY_EN = {
  machineOnline: 'Online',
  machineOffline: 'Offline',
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
    machineOnline: '在线',
    machineOffline: '离线',
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
