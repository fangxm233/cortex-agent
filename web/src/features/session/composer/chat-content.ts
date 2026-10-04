import type { Vocab } from '@/i18n';

export interface ToolCall {
  kind: string;
  input: string;
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
