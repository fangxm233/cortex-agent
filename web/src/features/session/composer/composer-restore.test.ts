import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDraft, saveDraft } from './composer-draft';
import { registerComposerRestore, restoreIntoComposer } from './composer-restore';

const KEY = 'cortex.composerDraft.session.s1';

describe('restoreIntoComposer', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('hands the message to the composer showing that scope', () => {
    const handler = vi.fn();
    const stop = registerComposerRestore(KEY, handler);
    restoreIntoComposer(KEY, { text: 'tell me the wiring', attachments: [] });
    expect(handler).toHaveBeenCalledWith({ text: 'tell me the wiring', attachments: [] });
    stop();
  });

  it('puts it in front of the stored draft when no composer shows the scope', () => {
    saveDraft(KEY, { text: 'half typed', attachments: [] });
    const stop = registerComposerRestore(KEY, vi.fn());
    stop();
    restoreIntoComposer(KEY, { text: 'tell me the wiring', attachments: [] });
    expect(loadDraft(KEY)?.text).toBe('tell me the wiring\nhalf typed');
  });

  it('a composer that left does not drop the handler of the one that replaced it', () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = registerComposerRestore(KEY, first);
    const stopSecond = registerComposerRestore(KEY, second);
    stopFirst();
    restoreIntoComposer(KEY, { text: 'x', attachments: [] });
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    stopSecond();
  });
});
