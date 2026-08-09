// input:  tool-call details, attachments and UI shortcuts
// output: chat types and local slash-command catalog
// pos:    shared static shapes for workbench chat surfaces
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export interface ToolCall {
  label: string;
  kind: string;
  input: string;
  debug?: {
    toolInput: unknown;
    toolResult?: { content: string; isError: boolean };
    overCharacterThreshold?: true;
  };
}

/** Attachment metadata shared between composer and message display (15a). */
export interface AttachmentMeta {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  type: 'image' | 'video' | 'file';
}

/** UI-local composer shortcuts shared by desktop and mobile surfaces. */
export const SLASH_COMMANDS = [
  { cmd: '/new', desc: 'Start a new session' },
  { cmd: '/cancel', desc: 'Cancel the current run' },
  { cmd: '/compact', desc: 'Compact this session' },
  { cmd: '/profile', desc: 'Switch this session profile' },
  { cmd: '/settings', desc: 'Open settings' },
] as const;
