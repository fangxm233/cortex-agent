import type { EnvironmentSystemPrompt } from '@cortex-agent/ui-contract';
import { fmt, type Vocab } from '@/i18n';

type SourceVocab = Pick<Vocab, 'ttPromptInline' | 'ttPromptNone'>;

/** One line naming where the prompt lives: its file, the body, or nowhere. */
export function promptSource(prompt: EnvironmentSystemPrompt, L: SourceVocab): string {
  if (prompt.kind === 'file' && prompt.file) return `prompts/systemPrompts/${prompt.file}`;
  return prompt.kind === 'inline' ? L.ttPromptInline : L.ttPromptNone;
}

export function sharedNotice(prompt: EnvironmentSystemPrompt, L: Pick<Vocab, 'ttPromptShared'>): string | null {
  return prompt.sharedWith.length > 0 ? fmt(L.ttPromptShared, { envs: prompt.sharedWith.join(', ') }) : null;
}

export interface PromptEditorState {
  text: string;
  dirty: boolean;
  /** A save would rewrite the environment body, which has unsaved edits of its own. */
  locked: boolean;
  canSave: boolean;
  canRevert: boolean;
  canRestore: boolean;
}

/**
 * The editor over one environment's prompt. `draft` null means untouched: the loaded text shows.
 * Only a prompt kept in a file saves without touching the body, so the others lock while the body
 * editor is dirty.
 */
export function promptEditorState(args: {
  prompt: EnvironmentSystemPrompt;
  draft: string | null;
  bodyDirty: boolean;
  pending: boolean;
}): PromptEditorState {
  const { prompt, draft, bodyDirty, pending } = args;
  const text = draft ?? prompt.text;
  const dirty = text !== prompt.text;
  const locked = bodyDirty && prompt.kind !== 'file';
  return {
    text,
    dirty,
    locked,
    canSave: dirty && !locked && !pending,
    canRevert: dirty && !pending,
    canRestore: prompt.defaultText !== null && text !== prompt.defaultText && !pending,
  };
}
