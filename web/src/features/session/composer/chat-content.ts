export interface ToolCall {
  label: string;
  kind: string;
  input: string;
  debug?: {
    toolRef?: string;
    toolInput?: unknown;
    toolResult?: { content: string; isError: boolean };
    overCharacterThreshold?: true;
  };
}

/** UI-local composer shortcuts shared by desktop and mobile surfaces; `desc` is per UI language. */
export const SLASH_COMMANDS = [
  { cmd: '/new', desc: { en: 'Start a new session', zh: '开始新会话' } },
  { cmd: '/cancel', desc: { en: 'Cancel the current run', zh: '取消当前运行' } },
  { cmd: '/compact', desc: { en: 'Compact this session', zh: '压缩此会话' } },
  { cmd: '/profile', desc: { en: 'Switch this session profile', zh: '切换此会话的配置' } },
  { cmd: '/settings', desc: { en: 'Open settings', zh: '打开设置' } },
] as const;
