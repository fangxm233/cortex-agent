// input:  nothing (leaf data slice)
// output: statusEn / statusZh — message slice (filled by i18n extraction)
// pos:    one locale slice; aggregated by core/locales/en.ts & zh.ts barrels
// >>> Keep en and zh keys in lockstep (zh typed against keyof typeof statusEn) <<<

export const statusEn = {
  // --- Status / lifecycle phrases ---
  'status.processing': 'Processing',
  'status.done': 'Done',
  'status.waitingForUserInput': 'Waiting for user input',
  'status.backgroundRunning': 'Background task running',
  'status.backgroundInterrupted': 'Background task interrupted — session ended before completion delivery',
  'status.backgroundStillRunning': 'Background task still running — no longer holding this turn; results will be appended here when it finishes',
  'status.cancelled': 'Cancelled',
  'status.error': 'Error',
  'status.supersededByEdit': 'Superseded by edit',
  'status.retryEdited': 'edited',
  'status.retry': 'Retry',
  'status.rateLimitedExhausted': 'Rate limited — all fallbacks exhausted',
  'status.supersededSeeNewReply': 'see new reply',
  'status.processingAskResponse': 'Processing AskUserQuestion response...',
  'status.errorBody': 'Error: ${message}',
  // --- Turn-completion notification ---
  'notify.turnComplete': 'Turn complete',
  'notify.turnFailed': 'Turn failed',
  // --- Context compaction notification ---
  'notify.contextCompacted': 'Context auto-compacted.',
  // --- Execution report ---
  'status.noRunningExecutions': 'No running executions.',
  'status.runningExecutions': 'Running executions: ${count}',
  // --- Button labels ---
  'btn.cancel': 'Cancel',
  'btn.resume': 'Resume',
  'btn.new': 'New',
  'btn.newq': 'New (quiet)',
} as const;

export const statusZh: Record<keyof typeof statusEn, string> = {
  // --- Status / lifecycle phrases ---
  'status.processing': '处理中',
  'status.done': '完成',
  'status.waitingForUserInput': '等待用户输入',
  'status.backgroundRunning': '后台任务运行中',
  'status.backgroundInterrupted': '后台任务被中断——会话在结果送达前结束',
  'status.backgroundStillRunning': '后台任务仍在运行——不再占位等待，完成后结果将追加到本回复',
  'status.cancelled': '已取消',
  'status.error': '错误',
  'status.supersededByEdit': '已被编辑取代',
  'status.retryEdited': '已编辑',
  'status.retry': '重试',
  'status.rateLimitedExhausted': '触发限流 — 所有回退已用尽',
  'status.supersededSeeNewReply': '查看新回复',
  'status.processingAskResponse': '正在处理 AskUserQuestion 回复……',
  'status.errorBody': '错误：${message}',
  // --- Turn-completion notification ---
  'notify.turnComplete': '回合完成',
  'notify.turnFailed': '回合失败',
  // --- Context compaction notification ---
  'notify.contextCompacted': '上下文已自动压缩。',
  // --- Execution report ---
  'status.noRunningExecutions': '没有正在运行的执行。',
  'status.runningExecutions': '正在运行的执行：${count}',
  // --- Button labels ---
  'btn.cancel': '取消',
  'btn.resume': '恢复',
  'btn.new': '新建',
  'btn.newq': '新建(静默)',
};
