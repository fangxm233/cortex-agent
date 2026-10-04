// File/media previewers (modal, lightbox and their docked bodies).
export const mediaEn = {
  mediaTextTooLarge: 'File too large to preview — download to view.',
  mediaPdfLoading: 'Loading PDF…',
  mediaPdfFailed: 'Failed to render {name}',
  mediaPrevPage: 'Previous page',
  mediaPageNumber: 'Page number',
  mediaNextPage: 'Next page',
  mediaZoomReset: 'Reset zoom',
  mediaPin: 'Pin preview beside the chat',
  mediaViewLoading: 'Loading view…',
  mediaViewTooLarge: 'View too large to render — download to open it.',
};
export const mediaZh: Record<keyof typeof mediaEn, string> = {
  mediaTextTooLarge: '文件太大，无法预览 —— 请下载后查看。',
  mediaPdfLoading: '正在加载 PDF…',
  mediaPdfFailed: '无法渲染 {name}',
  mediaPrevPage: '上一页',
  mediaPageNumber: '页码',
  mediaNextPage: '下一页',
  mediaZoomReset: '重置缩放',
  mediaPin: '停靠到聊天旁预览',
  mediaViewLoading: '正在加载视图…',
  mediaViewTooLarge: '视图太大，无法渲染 —— 请下载后打开。',
};

// The dock's own chrome; file bodies use the media keys, web tabs the browser keys.
export const dockEn = {
  dockEmptyHint: 'Click a file to preview it here, or open a web page with ＋.',
  dockResize: 'Drag to resize',
  dockCloseDock: 'Close the dock',
  dockCloseTab: 'Close tab',
  dockRendered: 'Rendered',
  dockShowRendered: 'Show the rendered Markdown',
  dockShowSource: 'Show the unrendered Markdown source',
};
export const dockZh: Record<keyof typeof dockEn, string> = {
  dockEmptyHint: '点击文件在这里预览，或用 ＋ 打开网页。',
  dockResize: '拖动调整大小',
  dockCloseDock: '关闭停靠面板',
  dockCloseTab: '关闭标签页',
  dockRendered: '渲染',
  dockShowRendered: '显示渲染后的 Markdown',
  dockShowSource: '显示未渲染的 Markdown 源码',
};
