import type { Vocab } from '@/i18n';

/** An image a tool call returned to the model, filed under the session's workspace. */
export interface ToolCallImage {
  name: string;
  path: string;
}

export interface ToolCall {
  kind: string;
  input: string;
  /** Present only when the call's result carried images; such calls render in their own row. */
  images?: ToolCallImage[];
  debug?: {
    toolRef?: string;
    toolInput?: unknown;
    toolResult?: { content: string; isError: boolean };
    overCharacterThreshold?: true;
  };
}

/** UI-local composer shortcuts shared by desktop and mobile surfaces; `desc` names the vocab description. */
export const SLASH_COMMANDS = [
  { cmd: '/new', desc: 'chatSlashNew' },
  { cmd: '/cancel', desc: 'chatSlashCancel' },
  { cmd: '/compact', desc: 'chatSlashCompact' },
  { cmd: '/profile', desc: 'chatSlashProfile' },
  { cmd: '/settings', desc: 'chatSlashSettings' },
] as const;

export type SlashVocab = Pick<Vocab, (typeof SLASH_COMMANDS)[number]['desc']>;
