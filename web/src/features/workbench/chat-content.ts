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

/** UI-local composer shortcuts shared by desktop and mobile surfaces. */
export const SLASH_COMMANDS = [
  { cmd: '/new', desc: 'Start a new session' },
  { cmd: '/cancel', desc: 'Cancel the current run' },
  { cmd: '/compact', desc: 'Compact this session' },
  { cmd: '/profile', desc: 'Switch this session profile' },
  { cmd: '/settings', desc: 'Open settings' },
] as const;
