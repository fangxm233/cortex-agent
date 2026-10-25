// File/media previewers (modal, lightbox and their docked bodies).
export const mediaEn = {
  mediaInlineFailed: 'Could not load media.',
  mediaInlineOffline: 'Device offline. Reconnect and reload.',
  mediaInlineNotFound: 'File not found.',
  mediaInlineUnsupported: 'Unsupported image or video format.',
  mediaInlineTooLarge: 'File exceeds 200 MB.',
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
  mediaInlineFailed: '无法加载图片或视频。',
  mediaInlineOffline: '设备离线，请连接后重新加载。',
  mediaInlineNotFound: '文件不存在。',
  mediaInlineUnsupported: '不支持的图片或视频格式。',
  mediaInlineTooLarge: '文件超过 200 MB。',
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
  dockPinTab: 'Pin tab',
  dockUnpinTab: 'Unpin tab',
  dockRendered: 'Rendered',
  dockShowRendered: 'Show the rendered Markdown',
  dockShowSource: 'Show the unrendered Markdown source',
};
export const dockZh: Record<keyof typeof dockEn, string> = {
  dockEmptyHint: '点击文件在这里预览，或用 ＋ 打开网页。',
  dockResize: '拖动调整大小',
  dockCloseDock: '关闭停靠面板',
  dockCloseTab: '关闭标签页',
  dockPinTab: '固定标签页',
  dockUnpinTab: '取消固定标签页',
  dockRendered: '渲染',
  dockShowRendered: '显示渲染后的 Markdown',
  dockShowSource: '显示未渲染的 Markdown 源码',
};
