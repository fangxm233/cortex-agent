export const uiAuthEn = {
  uiLoginTitle: 'Sign in to Cortex',
  uiLoginHint: "Enter a pairing code from a signed-in device, or this server's client token.",
  uiLoginTokenLabel: 'Pairing code or client token',
  uiLoginSubmit: 'Sign in',
  uiLoginBusy: 'Signing in…',
  uiLoginRejected: 'That code or token was not accepted.',
  uiLoginUnreachable: 'Cannot reach the server.',
  uiLoginDisabled: 'Token sign-in is turned off on this server. Use the desktop app, or reach this page through Cloudflare Access.',
  uiLoginRetry: 'Try again',
  uiLogoutAction: 'Sign out of this browser',
};

export const uiAuthZh: Record<keyof typeof uiAuthEn, string> = {
  uiLoginTitle: '登录 Cortex',
  uiLoginHint: '输入已登录设备生成的配对码，或本服务器的 client token。',
  uiLoginTokenLabel: '配对码或 client token',
  uiLoginSubmit: '登录',
  uiLoginBusy: '正在登录…',
  uiLoginRejected: '配对码或 token 不正确。',
  uiLoginUnreachable: '无法连接到服务器。',
  uiLoginDisabled: '此服务器已关闭 token 登录。请使用桌面端，或通过 Cloudflare Access 打开本页面。',
  uiLoginRetry: '重试',
  uiLogoutAction: '退出此浏览器的登录',
};
