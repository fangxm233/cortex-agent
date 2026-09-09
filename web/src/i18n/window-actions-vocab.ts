// input:  window-action failure and fullscreen labels
// output: bilingual desktop window feedback
// pos:    User-visible native window action outcomes
// >>> Once updated, update this header and parent CORTEX.md <<<
export const windowActionsEn = {
  windowExitFullscreen: 'Exit full screen',
  windowActionFailed: 'Window action failed',
  windowActionFailedHint: 'The desktop app could not complete this action. Try again or update the app.',
  windowDevtoolsFailed: 'Developer tools unavailable',
  windowDevtoolsFailedHint: 'This desktop build could not open developer tools. Update the desktop app and try again.',
};
export const windowActionsZh: Record<keyof typeof windowActionsEn, string> = {
  windowExitFullscreen: '退出全屏',
  windowActionFailed: '窗口操作失败',
  windowActionFailedHint: '桌面 App 未能完成此操作，请重试或更新 App。',
  windowDevtoolsFailed: '开发者工具不可用',
  windowDevtoolsFailedHint: '当前桌面构建无法打开开发者工具，请更新桌面 App 后重试。',
};
