// input:  tool-call DEBUG details and composer command definitions
// output: ToolCall/AttachmentMeta types and slash-command menu data
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

/** slash-menu commands (prototype cmds L2115–2121; EN copy verbatim). Running an item dispatches
 *  its '/cmd' as a real slash command through sessions.send (task 970d, no new backend op). */
export const SLASH_COMMANDS = [
  { cmd: '/dispatch', desc: 'Dispatch a task to a remote machine' },
  { cmd: '/diff', desc: 'Show pending repo changes at the commit gate' },
  { cmd: '/devices', desc: 'gpu-01 · lab-4090 · mac-m3' },
  { cmd: '/pause', desc: 'Pause the current thread' },
  { cmd: '/status', desc: 'Session status summary' },
];
