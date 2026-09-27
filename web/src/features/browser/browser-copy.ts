import { useLangOptional } from '@/i18n';
import { nativeErrorText } from '@/lib/native-error';
import { ForwardError } from './forward';

// Wording for the docked browser pane. Provider-optional: the pane's tests render it bare.
const en = {
  toolbar: 'Browser controls',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  viewportWidth: 'Viewport width',
  viewportFit: 'Fit',
  portsTitle: 'Ports listening on the server or a connected device',
  ports: 'Ports',
  openExternal: 'Open in system browser',
  forwardedFrom: 'Forwarded from {source}',
  address: 'Browser address',
  addressPlaceholder: 'Port or http://host:port',
  listeningPorts: 'Listening ports',
  portSource: 'Port source',
  server: 'server',
  forwardNeedsDesktop: 'Forwarding needs the desktop app — these open as plain localhost here.',
  loading: 'Loading…',
  nothingListeningServer: 'Nothing is listening on the server’s loopback.',
  nothingListeningDevice: 'Nothing is listening on {device}’s loopback.',
  emptyTitle: 'Preview a page',
  emptyBody: 'Enter a port or a URL. Remote dev servers appear here once forwarded.',
  frameRefused: 'This site refuses to be embedded (X-Frame-Options). Open it in a real browser:',
  invalidAddress: 'Not a previewable address — use http(s), a host:port, or a bare port.',
  originConflict: 'Refused: that is this app’s own origin. Previewing it would hand the page your session.',
  forwardUnavailable: 'Port forwarding needs the desktop app.',
  listPortsFailed: 'Could not list server ports ({status})',
  requestFailed: 'Request failed ({status})',
  newTab: 'New tab',
  forwardUnsupportedUrl: 'This server address cannot be forwarded (http and https only)',
  forwardNoLocalPort: 'No local port is free for the forward',
  forwardPrivilegedPort: 'Only ports 1024 and above can be forwarded',
  forwardNoServer: 'No server is configured',
  forwardNoToken: 'No token is configured',
};

export type BrowserCopy = typeof en;

const zh: BrowserCopy = {
  toolbar: '浏览器控制',
  back: '后退',
  forward: '前进',
  reload: '刷新',
  viewportWidth: '视口宽度',
  viewportFit: '适应',
  portsTitle: '服务器或已连接设备上正在监听的端口',
  ports: '端口',
  openExternal: '在系统浏览器中打开',
  forwardedFrom: '转发自 {source}',
  address: '浏览器地址',
  addressPlaceholder: '端口或 http://host:port',
  listeningPorts: '监听中的端口',
  portSource: '端口来源',
  server: '服务器',
  forwardNeedsDesktop: '端口转发需要桌面应用 —— 这里只会按普通 localhost 打开。',
  loading: '加载中…',
  nothingListeningServer: '服务器的回环地址上没有任何监听。',
  nothingListeningDevice: '{device} 的回环地址上没有任何监听。',
  emptyTitle: '预览网页',
  emptyBody: '输入端口或 URL。远程开发服务器转发后会出现在这里。',
  frameRefused: '这个网站拒绝被嵌入（X-Frame-Options）。请在真正的浏览器中打开：',
  invalidAddress: '不是可预览的地址 —— 请用 http(s)、host:port 或单独的端口号。',
  originConflict: '已拒绝：这是本应用自己的源。预览它会把你的会话交给该页面。',
  forwardUnavailable: '端口转发需要桌面应用。',
  listPortsFailed: '无法列出服务器端口（{status}）',
  requestFailed: '请求失败（{status}）',
  newTab: '新标签页',
  forwardUnsupportedUrl: '无法转发这个服务器地址（仅支持 http 和 https）',
  forwardNoLocalPort: '没有可用于转发的本地端口',
  forwardPrivilegedPort: '只能转发 1024 及以上的端口',
  forwardNoServer: '尚未配置服务器',
  forwardNoToken: '尚未配置令牌',
};

export const BROWSER_COPY: { en: BrowserCopy; zh: BrowserCopy } = { en, zh };

export function useBrowserCopy(): BrowserCopy {
  return BROWSER_COPY[useLangOptional()];
}

// Codes the shell's `forward_start` rejects with (desktop/src-tauri/src/forward.rs).
function nativeForwardCopy(copy: BrowserCopy): Record<string, string> {
  return {
    forward_unsupported_server_url: copy.forwardUnsupportedUrl,
    forward_no_local_port: copy.forwardNoLocalPort,
    forward_privileged_port: copy.forwardPrivilegedPort,
    forward_no_server: copy.forwardNoServer,
    forward_no_token: copy.forwardNoToken,
  };
}

/** A forward/ports failure in the UI language; raw server detail passes through unchanged. */
export function forwardErrorText(error: unknown, copy: BrowserCopy): string {
  if (!(error instanceof ForwardError)) return nativeErrorText(error, nativeForwardCopy(copy));
  if (error.code === 'unavailable') return copy.forwardUnavailable;
  const template = error.code === 'list-ports' ? copy.listPortsFailed : copy.requestFailed;
  return template.replace('{status}', String(error.status));
}
