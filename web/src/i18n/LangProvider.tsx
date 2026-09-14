// input:  shell config, cached language, and (optionally) the server language sync
// output: LangProvider + useLang/useSetLang/useVocab/useLangSource/useIsMobile hooks
// pos:    Holds the active language. The VALUE is owned by the server (config/preferences.json →
//         `lang`), because the same knob decides what Cortex speaks in the conversation; this
//         provider just holds it, caches it for first paint, and writes changes back through the
//         sync seam. Mount <LangServerSync/> inside it wherever tRPC is available.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { isMobileShell } from '@/lib/desktop-config';
import { pickVocab, readStoredLang, storeLang, type Lang } from './lang';
import { type Vocab } from './vocab';

/** Where the active language came from; 'env' means CORTEX_LANG re-wins on the next server boot. */
export type LangSource = 'env' | 'file' | 'default' | 'cache';

interface LangContextValue {
  lang: Lang;
  vocab: Vocab;
  isMobile: boolean;
  source: LangSource;
  setLang: (lang: Lang) => void;
}

const LangContext = createContext<LangContextValue | null>(null);

/** Write-through seam: registered by <LangServerSync/>, absent in isolated component tests. */
export interface LangSyncHandle {
  /** Take the server's value as truth (no write-back). */
  adopt: (lang: Lang, source: LangSource) => void;
  /** Install (or clear) the function the toggle calls to persist a change server-side. */
  setWriter: (write: ((lang: Lang) => void) | null) => void;
}

const LangSyncContext = createContext<LangSyncHandle | null>(null);

/**
 * The language is ONE setting shared with the server (see `lang.ts`). This provider:
 *   1. paints immediately from the local cache (or the browser preference),
 *   2. adopts the server's value as soon as <LangServerSync/> reports it,
 *   3. writes every toggle back to the server, so the conversation switches language too.
 *
 * Without <LangServerSync/> mounted (isolated component tests, or a server that cannot be reached)
 * it degrades to the old cache-only behaviour instead of failing to render.
 */
export function LangProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ lang: Lang; source: LangSource }>(
    () => ({ lang: readStoredLang(), source: 'cache' }),
  );
  const isMobile = isMobileShell();
  const writerRef = useRef<((lang: Lang) => void) | null>(null);

  const setLang = useCallback((next: Lang) => {
    // Optimistic: the UI flips now, the server call confirms. A failed write is corrected by the
    // next config.get the sync component refetches — the server stays the source of truth.
    setState((prev) => (prev.lang === next ? prev : { lang: next, source: prev.source }));
    storeLang(next);
    writerRef.current?.(next);
  }, []);

  const sync = useMemo<LangSyncHandle>(() => ({
    adopt: (lang, source) => {
      storeLang(lang);
      setState((prev) => (prev.lang === lang && prev.source === source ? prev : { lang, source }));
    },
    setWriter: (write) => { writerRef.current = write; },
  }), []);

  const value = useMemo<LangContextValue>(
    () => ({ lang: state.lang, vocab: pickVocab(state.lang), isMobile, source: state.source, setLang }),
    [state.lang, state.source, isMobile, setLang],
  );

  return (
    <LangContext.Provider value={value}>
      <LangSyncContext.Provider value={sync}>{children}</LangSyncContext.Provider>
    </LangContext.Provider>
  );
}

function useLangContext(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within <LangProvider>');
  return ctx;
}

export function useLang(): Lang {
  return useLangContext().lang;
}

/** Provenance of the active language — the appearance panel warns when CORTEX_LANG pins it. */
export function useLangSource(): LangSource {
  return useLangContext().source;
}

// Change the active language (persisted server-side). Wired to the EN/中 toggle in the left rail
// footer, the appearance panel, and the mobile appearance screen — all the same one knob.
export function useSetLang(): (lang: Lang) => void {
  return useLangContext().setLang;
}

/** Internal: the seam <LangServerSync/> plugs into. Null when no provider is in scope. */
export function useLangSync(): LangSyncHandle | null {
  return useContext(LangSyncContext);
}

// The vocabulary accessor — mirrors the prototype's `const L = this.dict()` idiom.
export function useVocab(): Vocab {
  return useLangContext().vocab;
}

// Provider-optional vocabulary accessor: returns the active-language vocab when a LangProvider is in
// scope, else the default-language vocab. Lets shared helpers (e.g. useDownloadFile) run inside
// isolated component tests that render a previewer bare, without a LangProvider.
export function useVocabOptional(): Vocab {
  const ctx = useContext(LangContext);
  return ctx?.vocab ?? pickVocab(readStoredLang());
}

// True only inside the dedicated mobile client shell. Drives the mobile/desktop render switch.
export function useIsMobile(): boolean {
  return useLangContext().isMobile;
}
