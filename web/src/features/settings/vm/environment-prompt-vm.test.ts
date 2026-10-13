import { describe, expect, it } from 'vitest';
import type { EnvironmentSystemPrompt } from '@cortex-agent/ui-contract';
import { en } from '@/i18n/vocab';
import { promptEditorState, promptSource, sharedNotice } from './environment-prompt-vm';

function prompt(over: Partial<EnvironmentSystemPrompt> = {}): EnvironmentSystemPrompt {
  return { kind: 'file', file: 'direct.md', text: 'loaded', sharedWith: [], defaultText: null, ...over };
}

const state = (p: EnvironmentSystemPrompt, draft: string | null, bodyDirty = false, pending = false) =>
  promptEditorState({ prompt: p, draft, bodyDirty, pending });

describe('promptSource', () => {
  it('names the file, the body, or the backend default', () => {
    expect(promptSource(prompt(), en)).toBe('prompts/systemPrompts/direct.md');
    expect(promptSource(prompt({ kind: 'inline', file: null }), en)).toBe(en.ttPromptInline);
    expect(promptSource(prompt({ kind: 'none', file: null, text: '' }), en)).toBe(en.ttPromptNone);
  });
});

describe('sharedNotice', () => {
  it('lists the other environments only when there are some', () => {
    expect(sharedNotice(prompt(), en)).toBeNull();
    expect(sharedNotice(prompt({ sharedWith: ['a', 'b'] }), en)).toBe('Also used by: a, b. Saving changes them too.');
  });
});

describe('promptEditorState', () => {
  it('shows the loaded text until edited, then allows save and revert', () => {
    expect(state(prompt(), null)).toMatchObject({ text: 'loaded', dirty: false, canSave: false, canRevert: false });
    expect(state(prompt(), 'edited')).toMatchObject({ text: 'edited', dirty: true, canSave: true, canRevert: true });
  });

  it('a draft equal to the loaded text is clean', () => {
    expect(state(prompt(), 'loaded').dirty).toBe(false);
  });

  it('locks only prompts whose save rewrites the dirty body', () => {
    expect(state(prompt(), 'edited', true)).toMatchObject({ locked: false, canSave: true });
    const inline = state(prompt({ kind: 'inline', file: null }), 'edited', true);
    expect(inline).toMatchObject({ locked: true, canSave: false, canRevert: true });
    expect(state(prompt({ kind: 'none', file: null, text: '' }), 'new', true).locked).toBe(true);
  });

  it('offers restore only when a shipped copy exists and differs', () => {
    expect(state(prompt(), null).canRestore).toBe(false);
    expect(state(prompt({ defaultText: 'shipped' }), null).canRestore).toBe(true);
    expect(state(prompt({ defaultText: 'shipped' }), 'shipped').canRestore).toBe(false);
  });

  it('disables every action while a save is in flight', () => {
    const pending = state(prompt({ defaultText: 'shipped' }), 'edited', false, true);
    expect(pending).toMatchObject({ canSave: false, canRevert: false, canRestore: false });
  });
});
