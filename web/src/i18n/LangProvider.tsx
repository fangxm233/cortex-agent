import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { isMobileShell } from '@/lib/desktop-config';
import { pickVocab, readStoredLang, storeLang, type Lang } from './lang';
import { type Vocab } from './vocab';

interface LangContextValue {
  lang: Lang;
  vocab: Vocab;
  isMobile: boolean;
  setLang: (lang: Lang) => void;
}

const LangContext = createContext<LangContextValue | null>(null);

// Language is a real, user-controlled, persisted choice (the EN/中 toggle) — NOT derived from the
// viewport width. Mobile layout is selected ONLY by the dedicated mobile client shell
// (`isMobileShell()`), so resizing a browser window never switches to the mobile UI.
export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang);
  const isMobile = isMobileShell();

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    storeLang(next);
  }, []);

  const value = useMemo<LangContextValue>(
    () => ({ lang, vocab: pickVocab(lang), isMobile, setLang }),
    [lang, isMobile, setLang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

function useLangContext(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within <LangProvider>');
  return ctx;
}

export function useLang(): Lang {
  return useLangContext().lang;
}

// Change the active language (persisted). Wired to the EN/中 toggle in the left rail footer.
export function useSetLang(): (lang: Lang) => void {
  return useLangContext().setLang;
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
