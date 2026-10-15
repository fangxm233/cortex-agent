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

// Workbench chrome: chat header, rail menus, run list, composer chips.
export const workbenchEn = {
  wbOpenWebPage: 'Open a web page in the dock',
  wbSessionMenu: 'Session menu',
  wbSessionsFailed: 'Failed to load conversations',
  wbAttachQueued: 'queued',
  wbAttachRetry: 'retry',
  wbRunCaption: 'RUN',
  wbFiredCaption: 'FIRED',
  wbCostCaption: 'COST',
  wbRailResize: 'Drag to resize the sidebar, double-click to reset',
};
export const workbenchZh: Record<keyof typeof workbenchEn, string> = {
  wbOpenWebPage: '在停靠面板中打开网页',
  wbSessionMenu: '会话菜单',
  wbSessionsFailed: '无法加载会话',
  wbAttachQueued: '排队中',
  wbAttachRetry: '重试',
  wbRunCaption: '运行',
  wbFiredCaption: '触发',
  wbCostCaption: '费用',
  wbRailResize: '拖动调整侧栏宽度，双击恢复默认',
};

// Approval center (desktop overlay) and the mobile approval queue.
export const approvalsEn = {
  apprPillPending: '● pending',
  apprPillApproved: '✓ approved',
  apprPillRejected: '✕ rejected',
  apprPillFailed: 'failed',
  apprPendingOne: '{n} approval pending',
  apprPendingMany: '{n} approvals pending',
  apprQueuedAt: 'queued {date}',
  apprToProcess: 'pending',
  apprTier: 'Approval',
  apprPaused: 'waiting for your decision',
  apprRejectFeedback: 'Reject with feedback',
  apprFeedbackPlaceholder: 'Optional feedback',
  apprSeeDiff: 'tap for diff ›',
  apprEmpty: 'No pending approvals',
  apprGlobalGroup: 'GLOBAL',
};
export const approvalsZh: Record<keyof typeof approvalsEn, string> = {
  apprPillPending: '● 待审批',
  apprPillApproved: '✓ 已批准',
  apprPillRejected: '✕ 已拒绝',
  apprPillFailed: '失败',
  apprPendingOne: '{n} 条待审批',
  apprPendingMany: '{n} 条待审批',
  apprQueuedAt: '排队于 {date}',
  apprToProcess: '待处理',
  apprTier: '审批',
  apprPaused: '等待你的决定',
  apprRejectFeedback: '拒绝并反馈',
  apprFeedbackPlaceholder: '可选反馈',
  apprSeeDiff: '点开看 diff ›',
  apprEmpty: '没有待处理的审批',
  apprGlobalGroup: '全局',
};

// Attachment upload errors (composer chips, desktop and mobile).
export const attachmentsEn = {
  attTooLarge: 'File too large',
  attUploadFailed: 'Upload failed',
  attNetworkError: 'Network error',
  attUploadCancelled: 'Upload cancelled',
};
export const attachmentsZh: Record<keyof typeof attachmentsEn, string> = {
  attTooLarge: '文件太大',
  attUploadFailed: '上传失败',
  attNetworkError: '网络错误',
  attUploadCancelled: '已取消上传',
};
