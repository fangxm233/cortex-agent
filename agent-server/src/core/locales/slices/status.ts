// input:  nothing (leaf data slice)
// output: statusEn/statusZh lifecycle and auth warning messages
// pos:    one locale slice; aggregated by core/locales/en.ts & zh.ts barrels
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// Keep en and zh keys in lockstep (zh is typed against keyof typeof statusEn).

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
  'status.rateLimitedExhausted': 'Rate limited',
  'status.supersededSeeNewReply': 'see new reply',
  'status.processingAskResponse': 'Processing AskUserQuestion response...',
  'status.errorBody': 'Error: ${message}',
  // --- Turn-completion notification ---
  'notify.turnComplete': 'Turn complete',
  'notify.turnFailed': 'Turn failed',
  // --- Semantic chat notices ---
  'notify.contextCompacted': 'Context auto-compacted.',
  'notify.agentFallback': 'Model fallback: ${from} → ${to}.',
  'notify.backendSessionReset': 'Previous backend session was unavailable; started a fresh session.',
  'notify.rateLimitAutoResume': 'Rate limited — this chat will resume automatically when the limit resets.',
  // --- Authentication-required notification ---
  'notify.authRequired.title': 'Authentication required',
  'notify.authRequired.body': 'Authentication required for backend `${backend}` / provider `${provider}` (${kind}). ${guidance}',
  'notify.authRequired.kind.loginRequired': 'login required',
  'notify.authRequired.kind.oauthExpired': 'OAuth login expired',
  'notify.authRequired.kind.invalidApiKey': 'invalid API key',
  'notify.authRequired.kind.unauthorized': 'unauthorized request',
  'notify.authRequired.kind.invalidGrant': 'invalid OAuth grant',
  'notify.authRequired.guide.action': 'Use the one-click login action below to sign in again.',
  'notify.authRequired.guide.claude': 'SSH to the Cortex host and run `claude /login` to sign in again.',
  'notify.authRequired.guide.pi': 'SSH to the Cortex host, run `pi`, then enter `/login` and select provider `${provider}`.',
  // --- Scheduled authentication status warning ---
  'notify.authExpiry.title': 'Authentication status warning',
  'notify.authExpiry.body': 'Backend `${backend}` / provider `${provider}` is ${state}.${expiry} ${guidance}',
  'notify.authExpiry.state.expiring': 'expiring',
  'notify.authExpiry.state.expired': 'expired',
  'notify.authExpiry.state.loggedOut': 'logged out',
  'notify.authExpiry.expiresAt': 'Expires at `${expiresAt}`.',
  'notify.authExpiry.refreshExpiresAt': 'Refresh credential expires at `${expiresAt}`.',
  'notify.authExpiry.guide.action': 'Use the one-click login action below to sign in again.',
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
  'status.rateLimitedExhausted': '触发限流',
  'status.supersededSeeNewReply': '查看新回复',
  'status.processingAskResponse': '正在处理 AskUserQuestion 回复……',
  'status.errorBody': '错误：${message}',
  // --- Turn-completion notification ---
  'notify.turnComplete': '回合完成',
  'notify.turnFailed': '回合失败',
  // --- Semantic chat notices ---
  'notify.contextCompacted': '上下文已自动压缩。',
  'notify.agentFallback': '模型回退：${from} → ${to}。',
  'notify.backendSessionReset': '之前的后端会话不可用，已启动新会话。',
  'notify.rateLimitAutoResume': '触发限流，解除后此对话将自动续跑。',
  // --- Authentication-required notification ---
  'notify.authRequired.title': '需要重新认证',
  'notify.authRequired.body': '后端 `${backend}` / Provider `${provider}` 的认证已失效（${kind}）。${guidance}',
  'notify.authRequired.kind.loginRequired': '需要登录',
  'notify.authRequired.kind.oauthExpired': 'OAuth 登录已过期',
  'notify.authRequired.kind.invalidApiKey': 'API Key 无效',
  'notify.authRequired.kind.unauthorized': '请求未获授权',
  'notify.authRequired.kind.invalidGrant': 'OAuth 授权已失效',
  'notify.authRequired.guide.action': '请使用下方的一键登录操作重新认证。',
  'notify.authRequired.guide.claude': '请 SSH 到 Cortex 主机并运行 `claude /login` 重新登录。',
  'notify.authRequired.guide.pi': '请 SSH 到 Cortex 主机，运行 `pi`，然后输入 `/login` 并选择 Provider `${provider}`。',
  // --- Scheduled authentication status warning ---
  'notify.authExpiry.title': '认证状态预警',
  'notify.authExpiry.body': '后端 `${backend}` / Provider `${provider}` 的认证状态为${state}。${expiry} ${guidance}',
  'notify.authExpiry.state.expiring': '即将过期',
  'notify.authExpiry.state.expired': '已过期',
  'notify.authExpiry.state.loggedOut': '未登录',
  'notify.authExpiry.expiresAt': '过期时间：`${expiresAt}`。',
  'notify.authExpiry.refreshExpiresAt': '刷新凭据过期时间：`${expiresAt}`。',
  'notify.authExpiry.guide.action': '请使用下方的一键登录操作重新认证。',
  // --- Execution report ---
  'status.noRunningExecutions': '没有正在运行的执行。',
  'status.runningExecutions': '正在运行的执行：${count}',
  // --- Button labels ---
  'btn.cancel': '取消',
  'btn.resume': '恢复',
  'btn.new': '新建',
  'btn.newq': '新建(静默)',
};
