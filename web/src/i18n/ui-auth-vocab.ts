// input:  browser token-login states
// output: bilingual copy for the login screen and the sign-out control
// pos:    Browser token-login vocabulary chunk
// >>> If updated, update this header and parent CORTEX.md <<<

export const uiAuthEn = {
  uiLoginTitle: 'Sign in to Cortex',
  uiLoginHint: "Paste this server's client token. It is exchanged for a session cookie and is not stored in this page.",
  uiLoginTokenLabel: 'Client token',
  uiLoginSubmit: 'Sign in',
  uiLoginBusy: 'Signing in…',
  uiLoginRejected: 'That token was not accepted.',
  uiLoginUnreachable: 'Cannot reach the server.',
  uiLoginDisabled: 'Token sign-in is turned off on this server. Use the desktop app, or reach this page through Cloudflare Access.',
  uiLoginRetry: 'Try again',
  uiLogoutAction: 'Sign out of this browser',
};

export const uiAuthZh: Record<keyof typeof uiAuthEn, string> = {
  uiLoginTitle: '登录 Cortex',
  uiLoginHint: '粘贴本服务器的 client token。它会被换成一个会话 cookie，不会保存在此页面中。',
  uiLoginTokenLabel: 'Client token',
  uiLoginSubmit: '登录',
  uiLoginBusy: '正在登录…',
  uiLoginRejected: 'token 不正确。',
  uiLoginUnreachable: '无法连接到服务器。',
  uiLoginDisabled: '此服务器已关闭 token 登录。请使用桌面端，或通过 Cloudflare Access 打开本页面。',
  uiLoginRetry: '重试',
  uiLogoutAction: '退出此浏览器的登录',
};
