import { useVocab } from '@/i18n';
import { useTheme, useSetTheme, type Theme } from '@/theme';
import { SCard } from './settings-ui';

// Appearance settings panel (12a-adjacent). The ONE device-local, no-backend setting: color theme.
// The Light/Dark control mirrors the prototype's EN/中 segmented toggle (scheme 1a footer): the active
// segment is the ink-solid inverse chip. All colors are CSS-var tokens so the control itself re-themes.
// Persisted via the theme provider (localStorage `cortex.theme`) — no config.set, no daemon round-trip.

const MONO = "'IBM Plex Mono',monospace";

function ThemeSegmented({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  const L = useVocab();
  const seg = (t: Theme, label: string) => {
    const active = value === t;
    return (
      <button
        key={t}
        type="button"
        aria-pressed={active}
        data-theme-option={t}
        onClick={() => onChange(t)}
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
        {label}
      </button>
    );
  };
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
      {seg('light', L.stThemeLight)}
      {seg('dark', L.stThemeDark)}
    </div>
  );
}

export function AppearancePanel() {
  const L = useVocab();
  const theme = useTheme();
  const setTheme = useSetTheme();
  return (
    <div style={{ marginTop: 12, maxWidth: 760 }}>
      <SCard style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.stThemeLabel}</div>
            <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 3, lineHeight: 1.5 }}>
              {L.stThemeHint}
            </div>
          </div>
          <ThemeSegmented value={theme} onChange={setTheme} />
        </div>
      </SCard>
      <div style={{ marginTop: 10, font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)', paddingLeft: 2 }}>
        localStorage · cortex.theme
      </div>
    </div>
  );
}
