// input:  language, device-local theme providers, settings atoms
// output: appearance controls with glass theme preview frames
// pos:    Compact appearance controls and readable storage hints
// >>> Once updated, update this header and parent AGENTS.md <<<

import type { CSSProperties } from 'react';
import { useVocab, useLang, useSetLang, useLangSource, type Lang } from '@/i18n';
import {
  AccentPicker,
  PaletteControls,
  useAccentHue,
  useSetAccentHue,
  useAccentIntensity,
  useSetAccentIntensity,
  usePalette,
  useSetPaletteValue,
  useActivePreset,
  useApplyPreset,
  useResetPalette,
  useMotionMode,
  useSetMotionMode,
  useGlass,
  useSetGlass,
  useTheme,
  useSetTheme,
  type AccentIntensity,
  type AccentPickerCopy,
  type GlassLevel,
  type MotionMode,
  type PaletteControlsCopy,
  type Theme,
} from '@/theme';
import { SRowGroup, SRow, SSection, SSegmented } from '@/features/settings/ui/settings-kit';

// Device-local appearance controls persist through their providers with no daemon round-trip.

const MONO = "'IBM Plex Mono',monospace";

// ── Theme cards ─────────────────────────────────────────────────────────────
// Theme is the one appearance choice with a picture, so it gets one: a miniature of the workspace
// — backdrop, rail, content pane — rather than a third row of the same three-option segment.

interface ThemeCardSpec {
  id: Theme;
  label: string;
  preview: string;
  pane: string;
}

function themeCardStyle(active: boolean): CSSProperties {
  return {
    border: 0, padding: 6, borderRadius: 'var(--r-card)', background: 'var(--material-card-bg)',
    outline: active ? '1.5px solid var(--proto-accent)' : '1px solid var(--proto-line-2)',
    boxShadow: 'var(--material-card-shadow)',
    cursor: 'pointer', textAlign: 'left', display: 'block', width: '100%',
    transition: 'outline-color .12s',
  };
}

const PREVIEW_PANE_BASE: CSSProperties = { position: 'absolute', top: 10, height: 54, borderRadius: 5 };

function ThemeCard({ spec, active, onSelect }: {
  spec: ThemeCardSpec;
  active: boolean;
  onSelect: (id: Theme) => void;
}) {
  return (
    <button type="button" data-theme-option={spec.id} aria-pressed={active}
      onClick={() => onSelect(spec.id)} style={themeCardStyle(active)}>
      <div style={{ height: 74, borderRadius: 9, background: spec.preview, position: 'relative', overflow: 'hidden' }}>
        <span style={{ ...PREVIEW_PANE_BASE, left: 10, width: 26, background: spec.pane }} />
        <span style={{ ...PREVIEW_PANE_BASE, left: 42, right: 10, background: spec.pane }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 6px 4px' }}>
        <span style={{
          width: 14, height: 14, borderRadius: '50%', boxSizing: 'border-box', flex: 'none',
          border: active ? '1.5px solid var(--proto-accent)' : '1.5px solid var(--proto-line-3)',
          display: 'grid', placeItems: 'center',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: active ? 'var(--proto-accent)' : 'transparent' }} />
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{spec.label}</span>
      </div>
    </button>
  );
}

function ThemeSection() {
  const L = useVocab();
  const theme = useTheme();
  const setTheme = useSetTheme();
  const specs: ThemeCardSpec[] = [
    { id: 'light', label: L.stThemeLight, preview: 'var(--theme-preview-light)', pane: 'var(--theme-preview-pane-light)' },
    { id: 'dark', label: L.stThemeDark, preview: 'var(--theme-preview-dark)', pane: 'var(--theme-preview-pane-dark)' },
    { id: 'system', label: L.stThemeSystem, preview: 'var(--theme-preview-system)', pane: 'var(--theme-preview-pane-system)' },
  ];
  return (
    <SSection label={L.stThemeLabel}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 10 }}>
        {specs.map((spec) => (
          <ThemeCard key={spec.id} spec={spec} active={spec.id === theme} onSelect={setTheme} />
        ))}
      </div>
      <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', padding: '9px 2px 0', lineHeight: 1.6 }}>{L.stThemeHint}</div>
    </SSection>
  );
}

// ── Colour ──────────────────────────────────────────────────────────────────

function usePaletteCopy(): PaletteControlsCopy {
  const L = useVocab();
  return {
    presets: L.stPalettePresets, custom: L.stPaletteCustom, reset: L.stPaletteReset,
    background: L.stPaletteBackground, foreground: L.stPaletteForeground,
    hue: L.stPaletteHue, tint: L.stPaletteTint,
    lightness: L.stPaletteLightness, contrast: L.stPaletteContrast,
    presetNames: {
      default: L.stPresetDefault, graphite: L.stPresetGraphite, sepia: L.stPresetSepia,
      indigo: L.stPresetIndigo, forest: L.stPresetForest, rose: L.stPresetRose,
      deep: L.stPresetDeep,
    },
  };
}

function useAccentCopy(): AccentPickerCopy {
  const L = useVocab();
  return {
    label: L.stAccentLabel, default: L.stAccentDefault, blue: L.stAccentBlue,
    teal: L.stAccentTeal, violet: L.stAccentViolet, rose: L.stAccentRose,
    orange: L.stAccentOrange, custom: L.stAccentCustom, reset: L.stAccentReset,
  };
}

function ColorSection() {
  const L = useVocab();
  const accentHue = useAccentHue();
  const setAccentHue = useSetAccentHue();
  const accentIntensity = useAccentIntensity();
  const setAccentIntensity = useSetAccentIntensity();
  const palette = usePalette();
  const setPaletteValue = useSetPaletteValue();
  const activePreset = useActivePreset();
  const applyPreset = useApplyPreset();
  const resetPalette = useResetPalette();
  const accentCopy = useAccentCopy();
  const paletteCopy = usePaletteCopy();
  return (
    <SSection label={L.stPaletteLabel}>
      <SRowGroup>
        <SRow title={L.stAccentLabel} desc={L.stAccentHint}
          control={<AccentPicker hue={accentHue} copy={accentCopy} onChange={setAccentHue} />} />
        <SRow title={L.stAccentIntensityLabel} desc={L.stAccentIntensityHint} control={
          <SSegmented<AccentIntensity> value={accentIntensity} dataAttr="data-accent-intensity-option"
            ariaLabel={L.stAccentIntensityLabel} onChange={setAccentIntensity}
            options={[
              { id: 'soft', label: L.stAccentIntensitySoft },
              { id: 'normal', label: L.stAccentIntensityNormal },
              { id: 'vivid', label: L.stAccentIntensityVivid },
            ]} />
        } />
        <SRow title={L.stPaletteLabel} desc={L.stPaletteHint} align="flex-start">
          <div style={{ marginTop: 12 }}>
            <PaletteControls
              palette={palette} copy={paletteCopy} activePreset={activePreset}
              onPickPreset={applyPreset} onChange={setPaletteValue} onReset={resetPalette}
            />
          </div>
        </SRow>
      </SRowGroup>
    </SSection>
  );
}

// ── Surface and language ────────────────────────────────────────────────────

function SurfaceSection() {
  const L = useVocab();
  const motionMode = useMotionMode();
  const setMotionMode = useSetMotionMode();
  const glass = useGlass();
  const setGlass = useSetGlass();
  return (
    <SSection label={L.stGlassLabel}>
      <SRowGroup>
        <SRow title={L.stGlassLabel} desc={L.stGlassHint} control={
          <SSegmented<GlassLevel> value={glass} dataAttr="data-glass-option" ariaLabel={L.stGlassLabel}
            onChange={setGlass}
            options={[
              { id: 'off', label: L.stGlassOff }, { id: 'subtle', label: L.stGlassSubtle },
              { id: 'medium', label: L.stGlassMedium }, { id: 'strong', label: L.stGlassStrong },
            ]} />
        } />
        <SRow title={L.stMotionLabel} desc={L.stMotionHint} control={
          <SSegmented<MotionMode> value={motionMode} dataAttr="data-motion-option" ariaLabel={L.stMotionLabel}
            onChange={setMotionMode}
            options={[
              { id: 'system', label: L.stMotionSystem }, { id: 'full', label: L.stMotionFull },
              { id: 'reduced', label: L.stMotionReduced },
            ]} />
        } />
      </SRowGroup>
    </SSection>
  );
}

function LanguageSection() {
  const L = useVocab();
  const lang = useLang();
  const setLang = useSetLang();
  const langSource = useLangSource();
  // CORTEX_LANG re-wins at boot, so say so rather than let the toggle look authoritative.
  const hint = langSource === 'env' ? `${L.stLangHint} ${L.stLangEnvPinned}` : L.stLangHint;
  return (
    <SRowGroup>
      <SRow title={L.stLangLabel} desc={hint} control={
        <SSegmented<Lang> value={lang} dataAttr="data-lang-option" ariaLabel={L.stLangLabel}
          onChange={setLang}
          options={[{ id: 'en', label: L.stLangEnglish }, { id: 'zh', label: L.stLangChinese }]} />
      } />
    </SRowGroup>
  );
}

export function AppearancePanel() {
  return (
    <>
      <LanguageSection />
      <ThemeSection />
      <ColorSection />
      <SurfaceSection />
      <div style={{ font: `400 12px ${MONO}`, color: 'var(--proto-muted-2)', paddingLeft: 2, lineHeight: 1.7, overflowWrap: 'anywhere' }}>
        localStorage · cortex.lang · cortex.theme · cortex.palette · cortex.accent-hue · cortex.accent-intensity · cortex.glass · cortex.motion
      </div>
    </>
  );
}
