// input:  Local language/theme/accent providers and settings cards
// output: Desktop appearance settings panel
// pos:    Device-local desktop appearance controls
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { ReactNode } from 'react';
import { useVocab, useLang, useSetLang, type Lang } from '@/i18n';
import {
  AccentPicker,
  useAccentHue,
  useSetAccentHue,
  useAccentIntensity,
  useSetAccentIntensity,
  useSurfaceTone,
  useSetSurfaceTone,
  useMotionMode,
  useSetMotionMode,
  useTheme,
  useSetTheme,
  type AccentIntensity,
  type AccentPickerCopy,
  type MotionMode,
  type SurfaceTone,
  type Theme,
} from '@/theme';
import { SCard } from './settings-ui';

// Device-local appearance controls persist through their providers with no daemon round-trip.

const MONO = "'IBM Plex Mono',monospace";

function SegmentOption<T extends string>({ id, label, active, onChange, dataAttr }: {
  id: T;
  label: string;
  active: boolean;
  onChange: (value: T) => void;
  dataAttr: string;
}) {
  return (
    <button
      type="button" aria-pressed={active} {...{ [dataAttr]: id }} onClick={() => onChange(id)}
      style={{
        border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
        padding: '4px 16px', borderRadius: 6,
        background: active ? 'var(--ink-solid-bg)' : 'transparent',
        color: active ? 'var(--ink-solid-fg)' : 'var(--proto-muted-2)',
        transition: 'background .12s, color .12s',
      }}
    >
      {label}
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange, dataAttr }: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  dataAttr: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--proto-gray)', border: '1px solid var(--proto-line)', flex: 'none' }}>
      {options.map((option) => (
        <SegmentOption key={option.id} {...option} active={value === option.id} onChange={onChange} dataAttr={dataAttr} />
      ))}
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

// One card per setting, in the order a user reasons about appearance: what language the UI speaks,
// then the light/dark frame, then the surfaces inside it, then the accent on top, then motion.
function AppearanceCards() {
  const L = useVocab();
  const theme = useTheme();
  const setTheme = useSetTheme();
  const lang = useLang();
  const setLang = useSetLang();
  const accentHue = useAccentHue();
  const setAccentHue = useSetAccentHue();
  const accentIntensity = useAccentIntensity();
  const setAccentIntensity = useSetAccentIntensity();
  const surfaceTone = useSurfaceTone();
  const setSurfaceTone = useSetSurfaceTone();
  const motionMode = useMotionMode();
  const setMotionMode = useSetMotionMode();
  const accentCopy: AccentPickerCopy = {
    label: L.stAccentLabel, default: L.stAccentDefault, blue: L.stAccentBlue,
    teal: L.stAccentTeal, violet: L.stAccentViolet, rose: L.stAccentRose,
    orange: L.stAccentOrange, custom: L.stAccentCustom, reset: L.stAccentReset,
  };
  const cardStyle = { marginTop: 12, padding: '14px 16px' };
  return (
    <>
      <SCard style={{ padding: '14px 16px' }}>
        <SettingRow title={L.stLangLabel} hint={L.stLangHint} control={<Segmented<Lang> value={lang} options={[{ id: 'en', label: L.stLangEnglish }, { id: 'zh', label: L.stLangChinese }]} onChange={setLang} dataAttr="data-lang-option" />} />
      </SCard>
      <SCard style={cardStyle}>
        <SettingRow title={L.stThemeLabel} hint={L.stThemeHint} control={<Segmented<Theme> value={theme} options={[{ id: 'light', label: L.stThemeLight }, { id: 'dark', label: L.stThemeDark }, { id: 'system', label: L.stThemeSystem }]} onChange={setTheme} dataAttr="data-theme-option" />} />
      </SCard>
      <SCard style={cardStyle}>
        <SettingRow title={L.stSurfaceLabel} hint={L.stSurfaceHint} control={<Segmented<SurfaceTone> value={surfaceTone} options={[{ id: 'default', label: L.stSurfaceDefault }, { id: 'neutral', label: L.stSurfaceNeutral }, { id: 'contrast', label: L.stSurfaceContrast }]} onChange={setSurfaceTone} dataAttr="data-surface-option" />} />
      </SCard>
      <SCard style={cardStyle}>
        <SettingRow title={L.stAccentLabel} hint={L.stAccentHint} control={<AccentPicker hue={accentHue} copy={accentCopy} onChange={setAccentHue} />} />
      </SCard>
      <SCard style={cardStyle}>
        <SettingRow title={L.stAccentIntensityLabel} hint={L.stAccentIntensityHint} control={<Segmented<AccentIntensity> value={accentIntensity} options={[{ id: 'soft', label: L.stAccentIntensitySoft }, { id: 'normal', label: L.stAccentIntensityNormal }, { id: 'vivid', label: L.stAccentIntensityVivid }]} onChange={setAccentIntensity} dataAttr="data-accent-intensity-option" />} />
      </SCard>
      <SCard style={cardStyle}>
        <SettingRow title={L.stMotionLabel} hint={L.stMotionHint} control={<Segmented<MotionMode> value={motionMode} options={[{ id: 'system', label: L.stMotionSystem }, { id: 'full', label: L.stMotionFull }, { id: 'reduced', label: L.stMotionReduced }]} onChange={setMotionMode} dataAttr="data-motion-option" />} />
      </SCard>
    </>
  );
}

export function AppearancePanel() {
  return (
    <div style={{ marginTop: 12, maxWidth: 760 }}>
      <AppearanceCards />
      <div style={{ marginTop: 10, font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)', paddingLeft: 2 }}>
        localStorage · cortex.lang · cortex.theme · cortex.surface · cortex.accent-hue · cortex.accent-intensity · cortex.motion
      </div>
    </div>
  );
}
