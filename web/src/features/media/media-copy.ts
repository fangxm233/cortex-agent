import { useLangOptional } from '@/i18n';

// Wording for the file/media previewers (modal, lightbox, and their docked bodies). Provider-optional:
// the previewers are rendered bare in tests.
const en = {
  loading: 'Loading…',
  loadFailed: 'Failed to load {name}',
  textTooLarge: 'File too large to preview — download to view.',
  pdfLoading: 'Loading PDF…',
  pdfFailed: 'Failed to render {name}',
  prevPage: 'Previous page',
  pageNumber: 'Page number',
  nextPage: 'Next page',
  zoomOut: 'Zoom out',
  zoomReset: 'Reset zoom',
  zoomIn: 'Zoom in',
  pin: 'Pin preview beside the chat',
  download: 'Download',
  close: 'Close',
  viewLoading: 'Loading view…',
  viewTooLarge: 'View too large to render — download to open it.',
};

export type MediaCopy = typeof en;

const zh: MediaCopy = {
  loading: '加载中…',
  loadFailed: '无法加载 {name}',
  textTooLarge: '文件太大，无法预览 —— 请下载后查看。',
  pdfLoading: '正在加载 PDF…',
  pdfFailed: '无法渲染 {name}',
  prevPage: '上一页',
  pageNumber: '页码',
  nextPage: '下一页',
  zoomOut: '缩小',
  zoomReset: '重置缩放',
  zoomIn: '放大',
  pin: '停靠到聊天旁预览',
  download: '下载',
  close: '关闭',
  viewLoading: '正在加载视图…',
  viewTooLarge: '视图太大，无法渲染 —— 请下载后打开。',
};

export const MEDIA_COPY: { en: MediaCopy; zh: MediaCopy } = { en, zh };

export function useMediaCopy(): MediaCopy {
  return MEDIA_COPY[useLangOptional()];
}
