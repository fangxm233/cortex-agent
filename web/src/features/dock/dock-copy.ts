import { useLangOptional } from '@/i18n';

// Wording for the dock's own chrome. File bodies reuse the previewers' copy (`media-copy.ts`), web
// tabs the browser's (`browser-copy.ts`). Provider-optional: the pane's tests render it bare.
const en = {
  emptyHint: 'Click a file to preview it here, or open a web page with ＋.',
  resize: 'Drag to resize',
  closeDock: 'Close the dock',
  closeTab: 'Close tab',
  rendered: 'Rendered',
  source: 'Source',
  showRendered: 'Show the rendered Markdown',
  showSource: 'Show the unrendered Markdown source',
};

export type DockCopy = typeof en;

const zh: DockCopy = {
  emptyHint: '点击文件在这里预览，或用 ＋ 打开网页。',
  resize: '拖动调整大小',
  closeDock: '关闭停靠面板',
  closeTab: '关闭标签页',
  rendered: '渲染',
  source: '源码',
  showRendered: '显示渲染后的 Markdown',
  showSource: '显示未渲染的 Markdown 源码',
};

export const DOCK_COPY: { en: DockCopy; zh: DockCopy } = { en, zh };

export function useDockCopy(): DockCopy {
  return DOCK_COPY[useLangOptional()];
}
