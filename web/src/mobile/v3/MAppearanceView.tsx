// input:  appearance preferences, shared settings controls
// output: MAppearanceView
// pos:    Mobile appearance preferences in material cards
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

// @ds-adherence-ignore -- mobile v3 raw px/font by design §8.3 (matches MSettingsView row metrics)
import type { CSSProperties, ReactNode } from 'react';
import { MC, MONO } from '@/mobile/ui/kit';
import { SSegmented } from '@/features/settings/settings-kit';
import { MSettingsFrame as MScreen, MSettingsHeader as MDrillHeader,
  MSettingsBody as MScrollBody } from './MSettingsControls';
import type { Lang, LangSource } from '@/i18n';
import {
  AccentPicker,
  PaletteControls,
  type AccentHue,
  type AccentIntensity,
  type AccentPickerCopy,
  type GlassLevel,
  type MotionMode,
  type Palette,
  type PaletteControlsCopy,
  type PaletteKey,
  type Theme,
} from '@/theme';

export interface MAppearanceCopy {
  title: string;
  language: string;
  /** Says the switch also changes the language Cortex writes in — not just this UI. */
  languageHint: string;
  /** Shown instead of the plain hint when CORTEX_LANG pins the language server-side. */
  languageEnvPinned: string;
  theme: string;
  themeLight: string;
  themeDark: string;
  themeSystem: string;
  palette: PaletteControlsCopy;
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
  glass: string;
  /** Says what the levels actually change, and that Off is the one to pick when scrolling drags. */
  glassHint: string;
  glassOff: string;
  glassSubtle: string;
  glassMedium: string;
  glassStrong: string;
  motion: string;
  motionSystem: string;
  motionFull: string;
  motionReduced: string;
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div style={{ background: 'var(--material-card-bg)', boxShadow: 'var(--material-card-shadow)', border: `1px solid ${MC.hairline}`, borderRadius: 12 }}>
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
const HINT: CSSProperties = { fontSize: 12, color: MC.muted, marginTop: 4, lineHeight: 1.45, paddingRight: 8 };

function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return <SSegmented value={value} options={[...options]} onChange={onChange} ariaLabel={ariaLabel} />;
}

/** Label on the left, segmented control on the right — the row shape shared by every simple choice. */
function ChoiceRow<T extends string>({ title, hint, divider, ...segment }: {
  title: string;
  hint?: string;
  divider: boolean;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="mobile-settings-choice" style={rowStyle(divider)}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={TITLE}>{title}</div>
        {hint ? <div style={HINT} data-choice-hint>{hint}</div> : null}
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
  langSource,
  onSetLang,
  theme,
  onSetTheme,
  palette,
  onSetPaletteValue,
  activePreset,
  onPickPreset,
  onResetPalette,
  accentHue,
  onSetAccentHue,
  accentIntensity,
  onSetAccentIntensity,
  glass,
  onSetGlass,
  motionMode,
  onSetMotionMode,
  onBack,
}: {
  copy: MAppearanceCopy;
  lang: Lang;
  /** 'env' means CORTEX_LANG re-wins on the next server restart; anything else is a real choice. */
  langSource?: LangSource;
  onSetLang: (lang: Lang) => void;
  theme: Theme;
  onSetTheme: (theme: Theme) => void;
  palette: Palette;
  onSetPaletteValue: (key: PaletteKey, value: number) => void;
  activePreset: string | null;
  onPickPreset: (id: string) => void;
  onResetPalette: () => void;
  accentHue: AccentHue;
  onSetAccentHue: (hue: AccentHue) => void;
  accentIntensity: AccentIntensity;
  onSetAccentIntensity: (intensity: AccentIntensity) => void;
  glass: GlassLevel;
  onSetGlass: (level: GlassLevel) => void;
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
            hint={langSource === 'env' ? copy.languageEnvPinned : copy.languageHint}
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
          <div style={{ ...rowStyle(true), display: 'block' }}>
            <PaletteControls
              palette={palette} copy={copy.palette} activePreset={activePreset}
              onPickPreset={onPickPreset} onChange={onSetPaletteValue} onReset={onResetPalette}
            />
          </div>
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
            divider title={copy.glass} hint={copy.glassHint} ariaLabel={copy.glass} value={glass}
            options={[
              { id: 'off', label: copy.glassOff },
              { id: 'subtle', label: copy.glassSubtle },
              { id: 'medium', label: copy.glassMedium },
              { id: 'strong', label: copy.glassStrong },
            ] as const}
            onChange={onSetGlass}
          />
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

        <div style={{ padding: '2px 4px', font: `400 12px ${MONO}`, color: MC.faint }}>
          localStorage · cortex.lang · cortex.theme · cortex.palette · cortex.accent-hue ·
          cortex.accent-intensity · cortex.glass · cortex.motion
        </div>
      </MScrollBody>
    </MScreen>
  );
}
