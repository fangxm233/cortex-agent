// input:  appearance preferences, localized copy, mobile UI primitives
// output: mobile appearance drill-in with language, theme, color, and motion
// pos:    Presentational mobile appearance view
// >>> If I am updated, update my header comment and CORTEX.md <<<

// @ds-adherence-ignore -- mobile v3 raw px/font by design §8.3 (matches MSettingsView row metrics)
import type { CSSProperties, ReactNode } from 'react';
import { MScreen, MDrillHeader, MScrollBody, MC, MONO } from '@/mobile/ui/kit';
import type { Lang } from '@/i18n';
import {
  AccentPicker,
  type AccentHue,
  type AccentIntensity,
  type AccentPickerCopy,
  type MotionMode,
  type SurfaceTone,
  type Theme,
} from '@/theme';

export interface MAppearanceCopy {
  title: string;
  language: string;
  theme: string;
  themeLight: string;
  themeDark: string;
  themeSystem: string;
  surface: string;
  surfaceDefault: string;
  surfaceNeutral: string;
  surfaceContrast: string;
  accent: string;
  accentDefault: string;
  accentBlue: string;
  accentTeal: string;
  accentViolet: string;
  accentRose: string;
  accentOrange: string;
  accentCustom: string;
  accentReset: string;
  accentIntensity: string;
  accentIntensitySoft: string;
  accentIntensityNormal: string;
  accentIntensityVivid: string;
  motion: string;
  motionSystem: string;
  motionFull: string;
  motionReduced: string;
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div style={{ background: MC.card, border: `1px solid ${MC.hairline}`, borderRadius: 13, overflow: 'hidden' }}>
      {children}
    </div>
  );
}

function rowStyle(divider: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 13px',
    borderBottom: divider ? `1px solid ${MC.divider}` : undefined,
  };
}

const TITLE: CSSProperties = { fontSize: 14, fontWeight: 600, color: MC.ink };

function SegmentItem<T extends string>({ id, label, active, onChange }: {
  id: T;
  label: string;
  active: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <button
      type="button" aria-pressed={active} onClick={() => onChange(id)}
      style={{
        border: 0, fontSize: 11, fontWeight: 600, padding: '3px 10px', cursor: 'pointer',
        background: active ? 'var(--ink-solid-bg)' : 'transparent',
        color: active ? 'var(--ink-solid-fg)' : MC.muted,
      }}
    >
      {label}
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} style={{ display: 'flex', border: `1px solid ${MC.hairline}`, borderRadius: 6, overflow: 'hidden', flex: 'none' }}>
      {options.map((option) => (
        <SegmentItem key={option.id} {...option} active={value === option.id} onChange={onChange} />
      ))}
    </div>
  );
}

/** Label on the left, segmented control on the right — the row shape shared by every simple choice. */
function ChoiceRow<T extends string>({ title, divider, ...segment }: {
  title: string;
  divider: boolean;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div style={rowStyle(divider)}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={TITLE}>{title}</div>
      </div>
      <Segmented {...segment} />
    </div>
  );
}

// The swatch strip plus hue slider needs the full row width, so it stacks instead of sitting inline.
function AccentRow({ copy, hue, onChange }: {
  copy: MAppearanceCopy;
  hue: AccentHue;
  onChange: (hue: AccentHue) => void;
}) {
  const pickerCopy: AccentPickerCopy = {
    label: copy.accent, default: copy.accentDefault, blue: copy.accentBlue,
    teal: copy.accentTeal, violet: copy.accentViolet, rose: copy.accentRose,
    orange: copy.accentOrange, custom: copy.accentCustom, reset: copy.accentReset,
  };
  return (
    <div style={{ ...rowStyle(true), display: 'block' }}>
      <div style={TITLE}>{copy.accent}</div>
      <div style={{ marginTop: 9 }}>
        <AccentPicker hue={hue} copy={pickerCopy} onChange={onChange} compact />
      </div>
    </div>
  );
}

export function MAppearanceView({
  copy,
  lang,
  onSetLang,
  theme,
  onSetTheme,
  surfaceTone,
  onSetSurfaceTone,
  accentHue,
  onSetAccentHue,
  accentIntensity,
  onSetAccentIntensity,
  motionMode,
  onSetMotionMode,
  onBack,
}: {
  copy: MAppearanceCopy;
  lang: Lang;
  onSetLang: (lang: Lang) => void;
  theme: Theme;
  onSetTheme: (theme: Theme) => void;
  surfaceTone: SurfaceTone;
  onSetSurfaceTone: (tone: SurfaceTone) => void;
  accentHue: AccentHue;
  onSetAccentHue: (hue: AccentHue) => void;
  accentIntensity: AccentIntensity;
  onSetAccentIntensity: (intensity: AccentIntensity) => void;
  motionMode: MotionMode;
  onSetMotionMode: (mode: MotionMode) => void;
  onBack: () => void;
}) {
  return (
    <MScreen
      label="1l-ap 外观"
      header={
        <MDrillHeader onBack={onBack}>
          <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>
            {copy.title}
          </div>
        </MDrillHeader>
      }
    >
      <MScrollBody gap={10}>
        <Card>
          <ChoiceRow
            divider title={copy.language} ariaLabel={copy.language} value={lang}
            options={[{ id: 'en', label: 'EN' }, { id: 'zh', label: '中' }] as const}
            onChange={onSetLang}
          />
          <ChoiceRow
            divider={false} title={copy.theme} ariaLabel={copy.theme} value={theme}
            options={[
              { id: 'light', label: copy.themeLight },
              { id: 'dark', label: copy.themeDark },
              { id: 'system', label: copy.themeSystem },
            ] as const}
            onChange={onSetTheme}
          />
        </Card>

        <Card>
          <ChoiceRow
            divider title={copy.surface} ariaLabel={copy.surface} value={surfaceTone}
            options={[
              { id: 'default', label: copy.surfaceDefault },
              { id: 'neutral', label: copy.surfaceNeutral },
              { id: 'contrast', label: copy.surfaceContrast },
            ] as const}
            onChange={onSetSurfaceTone}
          />
          <AccentRow copy={copy} hue={accentHue} onChange={onSetAccentHue} />
          <ChoiceRow
            divider={false} title={copy.accentIntensity} ariaLabel={copy.accentIntensity}
            value={accentIntensity}
            options={[
              { id: 'soft', label: copy.accentIntensitySoft },
              { id: 'normal', label: copy.accentIntensityNormal },
              { id: 'vivid', label: copy.accentIntensityVivid },
            ] as const}
            onChange={onSetAccentIntensity}
          />
        </Card>

        <Card>
          <ChoiceRow
            divider={false} title={copy.motion} ariaLabel={copy.motion} value={motionMode}
            options={[
              { id: 'system', label: copy.motionSystem },
              { id: 'full', label: copy.motionFull },
              { id: 'reduced', label: copy.motionReduced },
            ] as const}
            onChange={onSetMotionMode}
          />
        </Card>

        <div style={{ padding: '2px 4px', font: `400 9.5px ${MONO}`, color: MC.faint }}>
          localStorage · cortex.lang · cortex.theme · cortex.surface · cortex.accent-hue ·
          cortex.accent-intensity · cortex.motion
        </div>
      </MScrollBody>
    </MScreen>
  );
}
