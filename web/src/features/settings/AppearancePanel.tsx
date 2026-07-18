import type { ReactNode } from 'react';
import { useVocab, useLang, useSetLang, type Lang } from '@/i18n';
import { useTheme, useSetTheme, type Theme } from '@/theme';
import { SCard } from './settings-ui';

// Appearance settings panel (12a-adjacent). The device-local, no-backend settings: interface
// language (EN/中) and color theme (light/dark). Both controls are ink-solid segmented toggles
// mirroring the prototype's footer chip; all colors are CSS-var tokens so the controls re-theme.
// The language control moved here from the left-rail footer (the rail footer now hosts the theme
// toggle). Persisted via their providers (localStorage `cortex.lang` / `cortex.theme`) — no
// config.set, no daemon round-trip.

const MONO = "'IBM Plex Mono',monospace";

// Shared ink-solid segmented control (light/dark or EN/中). `dataAttr` marks each option for tests.
function Segmented<T extends string>({
  value,
  options,
  onChange,
  dataAttr,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  dataAttr: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        background: 'var(--proto-gray)',
        border: '1px solid var(--proto-line)',
        flex: 'none',
      }}
    >
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            {...{ [dataAttr]: o.id }}
            onClick={() => onChange(o.id)}
            style={{
              border: 'none',
              cursor: 'pointer',
              fontSize: 11.5,
              fontWeight: 600,
              padding: '4px 16px',
              borderRadius: 6,
              background: active ? 'var(--ink-solid-bg)' : 'transparent',
              color: active ? 'var(--ink-solid-fg)' : 'var(--proto-muted-2)',
              transition: 'background .12s, color .12s',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// A labelled setting row: title + hint on the left, the segmented control on the right.
function SettingRow({ title, hint, control }: { title: string; hint: string; control: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{title}</div>
        <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 3, lineHeight: 1.5 }}>{hint}</div>
      </div>
      {control}
    </div>
  );
}

export function AppearancePanel() {
  const L = useVocab();
  const theme = useTheme();
  const setTheme = useSetTheme();
  const lang = useLang();
  const setLang = useSetLang();
  return (
    <div style={{ marginTop: 12, maxWidth: 760 }}>
      <SCard style={{ padding: '14px 16px' }}>
        <SettingRow
          title={L.stLangLabel}
          hint={L.stLangHint}
          control={
            <Segmented<Lang>
              value={lang}
              options={[
                { id: 'en', label: L.stLangEnglish },
                { id: 'zh', label: L.stLangChinese },
              ]}
              onChange={setLang}
              dataAttr="data-lang-option"
            />
          }
        />
      </SCard>
      <SCard style={{ marginTop: 12, padding: '14px 16px' }}>
        <SettingRow
          title={L.stThemeLabel}
          hint={L.stThemeHint}
          control={
            <Segmented<Theme>
              value={theme}
              options={[
                { id: 'light', label: L.stThemeLight },
                { id: 'dark', label: L.stThemeDark },
              ]}
              onChange={setTheme}
              dataAttr="data-theme-option"
            />
          }
        />
      </SCard>
      <div style={{ marginTop: 10, font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)', paddingLeft: 2 }}>
        localStorage · cortex.lang · cortex.theme
      </div>
    </div>
  );
}
