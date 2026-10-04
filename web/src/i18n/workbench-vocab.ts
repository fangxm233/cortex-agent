// Command palette chrome and its row kind tags.
export const paletteEn = {
  palLabel: 'Command palette',
  palClose: 'Close command palette',
  palKindCommand: 'command',
  palKindSession: 'session',
  palKindPage: 'page',
  palKindModal: 'modal',
};
export const paletteZh: Record<keyof typeof paletteEn, string> = {
  palLabel: '命令面板',
  palClose: '关闭命令面板',
  palKindCommand: '命令',
  palKindSession: '会话',
  palKindPage: '页面',
  palKindModal: '弹窗',
};

// Workbench chrome: right-panel machine pills, chat header, rail menus, run list, composer chips.
export const workbenchEn = {
  wbMachineOnline: 'Online',
  wbMachineOffline: 'Offline',
  wbOpenWebPage: 'Open a web page in the dock',
  wbSessionMenu: 'Session menu',
  wbNoSession: 'No session',
  wbAttachQueued: 'queued',
  wbAttachRetry: 'retry',
  wbRunCaption: 'RUN',
  wbFiredCaption: 'FIRED',
  wbCostCaption: 'COST',
  wbRailResize: 'Drag to resize the sidebar, double-click to reset',
};
export const workbenchZh: Record<keyof typeof workbenchEn, string> = {
  wbMachineOnline: '在线',
  wbMachineOffline: '离线',
  wbOpenWebPage: '在停靠面板中打开网页',
  wbSessionMenu: '会话菜单',
  wbNoSession: '无会话',
  wbAttachQueued: '排队中',
  wbAttachRetry: '重试',
  wbRunCaption: '运行',
  wbFiredCaption: '触发',
  wbCostCaption: '费用',
  wbRailResize: '拖动调整侧栏宽度，双击恢复默认',
};
