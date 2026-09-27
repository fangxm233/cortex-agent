// Text the native shell shows but cannot word itself (it does not know the UI language): the
// macOS application menu, the OS notification's open action, and save-download failure codes.
export const nativeShellEn = {
  appMenuAbout: 'About Cortex',
  appMenuServices: 'Services',
  appMenuHide: 'Hide Cortex',
  appMenuHideOthers: 'Hide Others',
  appMenuShowAll: 'Show All',
  appMenuQuit: 'Quit Cortex',
  notificationOpenAction: 'Open Cortex',
  downloadErrDir: 'No download folder is available',
  downloadErrCreateDir: 'Could not create the download folder',
  downloadErrWrite: 'Could not write the file',
};
export const nativeShellZh: Record<keyof typeof nativeShellEn, string> = {
  appMenuAbout: '关于 Cortex',
  appMenuServices: '服务',
  appMenuHide: '隐藏 Cortex',
  appMenuHideOthers: '隐藏其他',
  appMenuShowAll: '全部显示',
  appMenuQuit: '退出 Cortex',
  notificationOpenAction: '打开 Cortex',
  downloadErrDir: '找不到可用的下载文件夹',
  downloadErrCreateDir: '无法创建下载文件夹',
  downloadErrWrite: '无法写入文件',
};
