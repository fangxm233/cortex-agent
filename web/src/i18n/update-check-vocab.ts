// input:  manual update check states and native reason codes
// output: bilingual menu progress and per-channel feedback copy
// pos:    Manual update check vocabulary chunk
// >>> If updated, update this header and parent CORTEX.md <<<

export const updateCheckEn = {
  updateCheckBusy: 'Checking for updates…',
  updateCheckProgress: 'Checking and preparing UI and app shell updates. Nothing will be installed or restarted without confirmation.',
  updateCheckUi: 'UI update',
  updateCheckShell: 'App shell update',
  updateCheckAvailable: 'Update prepared. Review the update prompt to continue.',
  updateCheckCurrent: 'Up to date (checked just now).',
  updateCheckSkipped: 'Check skipped. Update status was not verified.',
  updateCheckError: 'Check failed. Could not verify whether this channel is up to date.',
  updateCheckCached: 'A previously prepared update is still available for confirmation; it is not a fresh check result.',
  updateCheckUnsupported: 'This app shell does not support manual update checks. Update the app shell to use this command.',
  updateCheckInvalid: 'The app shell returned an invalid update report. Update status could not be verified.',
  updateCheckCredentials: 'Connect to a server before checking for updates.',
  updateCheckDisabled: 'App shell update checks are disabled by the environment.',
  updateCheckDev: 'App shell update checks are disabled in development mode.',
  updateCheckSkippedVersion: 'This app shell version was previously skipped.',
  updateCheckNoAsset: 'No matching update package is available for this platform.',
  updateCheckInProgress: 'Another update operation is in progress. Try again when it finishes.',
  updateCheckRestartPending: 'An install or restart is already pending.',
  updateCheckNotScheduled: 'This channel was not included in the check.',
};

export const updateCheckZh: Record<keyof typeof updateCheckEn, string> = {
  updateCheckBusy: '正在检查更新…',
  updateCheckProgress: '正在检查并准备 UI 和 App 外壳更新。未经确认不会安装或重启。',
  updateCheckUi: 'UI 更新',
  updateCheckShell: 'App 外壳更新',
  updateCheckAvailable: '更新已准备好，请在更新提示中确认是否继续。',
  updateCheckCurrent: '已是最新（刚刚完成检查）。',
  updateCheckSkipped: '已跳过检查，未确认更新状态。',
  updateCheckError: '检查失败，无法确认此通道是否为最新。',
  updateCheckCached: '仍可确认使用之前已准备好的更新，但这不代表本次检查成功。',
  updateCheckUnsupported: '当前 App 外壳不支持手动检查更新，请先升级 App 外壳。',
  updateCheckInvalid: 'App 外壳返回的更新报告无效，无法确认更新状态。',
  updateCheckCredentials: '请先连接服务器，再检查更新。',
  updateCheckDisabled: '环境配置已禁用 App 外壳更新检查。',
  updateCheckDev: '开发模式下已禁用 App 外壳更新检查。',
  updateCheckSkippedVersion: '此前已选择跳过此 App 外壳版本。',
  updateCheckNoAsset: '没有适用于当前平台的更新包。',
  updateCheckInProgress: '其他更新操作正在进行，请完成后重试。',
  updateCheckRestartPending: '已有待执行的安装或重启。',
  updateCheckNotScheduled: '本次检查未包含此通道。',
};
