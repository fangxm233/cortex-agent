// input:  language/theme controls and native window actions
// output: onboarding brand header matching the native setup screens
// pos:    Shared-looking chrome for the provider setup step
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { useLang, useSetLang, useVocab } from '@/i18n';
import { useToggleTheme } from '@/theme';
import { captionInsetLeft, titleBarMode } from '@/lib/desktop-platform';
import { WindowControls } from '@/shell/WindowControls';
import { useWindowActions } from '@/shell/menu/useWindowActions';

function BrandMark() {
  return <span className="setup-brand-mark"><svg width="19" height="19" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <circle cx="33" cy="32" r="6" fill="var(--brand-badge-core)" />
    <path d="M42.29 23.64A12.5 12.5 0 1 0 42.29 40.36" stroke="var(--brand-badge-arc)" strokeWidth="6" strokeLinecap="round" />
    <path d="M48.6 17.95A21 21 0 1 0 48.6 46.05" stroke="var(--brand-badge-arc)" strokeWidth="6" strokeLinecap="round" />
  </svg></span>;
}
function AppearanceControls() {
  const lang = useLang(), setLang = useSetLang(), toggleTheme = useToggleTheme(), L = useVocab();
  return <div className="setup-header-actions">
    <button className="setup-theme-toggle" type="button" onClick={toggleTheme} aria-label={L.setupToggleTheme}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />
      </svg>
    </button>
    <div className="setup-lang-toggle" role="group" aria-label={L.setupLanguage}>
      {(['en', 'zh'] as const).map(value => <button key={value} type="button"
        aria-pressed={lang === value} onClick={() => setLang(value)}>{value === 'en' ? 'EN' : '中'}</button>)}
    </div>
  </div>;
}
function NativeCaption() {
  const actions = useWindowActions();
  return <WindowControls actions={actions} />;
}
export function SetupHeader() {
  const L = useVocab();
  const mode = titleBarMode();
  return <header className="setup-header" data-tauri-drag-region="deep" data-caption={mode}
    style={mode === 'overlay' ? { paddingLeft: captionInsetLeft() + 16 } : undefined}>
    <div className="setup-brand"><BrandMark />Cortex</div>
    <span className="setup-header-label">{L.setupHeader}</span>
    <AppearanceControls />
    {mode === 'custom' ? <NativeCaption /> : null}
  </header>;
}
