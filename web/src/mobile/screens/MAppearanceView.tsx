// @ds-adherence-ignore -- mobile v3 raw px/font by design §8.3 (matches MSettingsView row metrics)
import type { CSSProperties, ReactNode } from 'react';
import { MC } from '@/mobile/ui/kit';
import { SSegmented } from '@/features/settings/ui/settings-kit';
import { MSettingsFrame as MScreen, MSettingsHeader as MDrillHeader,
  MSettingsBody as MScrollBody } from './MSettingsControls';
import { useVocab, type Lang, type LangSource } from '@/i18n';
import { useAccentCopy, usePaletteCopy } from '@/features/settings/panels/AppearancePanel';
import {
  AccentPicker,
  PaletteControls,
  type AccentHue,
  type AccentIntensity,
  type GlassLevel,
  type MotionMode,
  type Palette,
  type PaletteKey,
  type Theme,
} from '@/theme';

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
      <SSegmented {...segment} options={[...segment.options]} />
    </div>
  );
}

// The swatch strip plus hue slider needs the full row width, so it stacks instead of sitting inline.
function AccentRow({ hue, onChange }: {
  hue: AccentHue;
  onChange: (hue: AccentHue) => void;
}) {
  const pickerCopy = useAccentCopy();
  return (
    <div style={{ ...rowStyle(true), display: 'block' }}>
      <div style={TITLE}>{pickerCopy.label}</div>
      <div style={{ marginTop: 9 }}>
        <AccentPicker hue={hue} copy={pickerCopy} onChange={onChange} compact />
      </div>
    </div>
  );
}

export function MAppearanceView({
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
  const L = useVocab();
  const paletteCopy = usePaletteCopy();
  return (
    <MScreen
      label="1l-ap appearance"
      header={
        <MDrillHeader onBack={onBack}>
          <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>
            {L.stNavAppearance}
          </div>
        </MDrillHeader>
      }
    >
      <MScrollBody>
        <Card>
          <ChoiceRow
            divider title={L.stLangLabel} ariaLabel={L.stLangLabel} value={lang}
            hint={langSource === 'env' ? L.stLangEnvPinned : L.stLangHint}
            options={[{ id: 'en', label: 'EN' }, { id: 'zh', label: '中' }] as const}
            onChange={onSetLang}
          />
          <ChoiceRow
            divider={false} title={L.stThemeLabel} ariaLabel={L.stThemeLabel} value={theme}
            options={[
              { id: 'light', label: L.stThemeLight },
              { id: 'dark', label: L.stThemeDark },
              { id: 'system', label: L.stThemeSystem },
            ] as const}
            onChange={onSetTheme}
          />
        </Card>

        <Card>
          <div style={{ ...rowStyle(true), display: 'block' }}>
            <PaletteControls
              palette={palette} copy={paletteCopy} activePreset={activePreset}
              onPickPreset={onPickPreset} onChange={onSetPaletteValue} onReset={onResetPalette}
            />
          </div>
          <AccentRow hue={accentHue} onChange={onSetAccentHue} />
          <ChoiceRow
            divider={false} title={L.appearIntensity} ariaLabel={L.appearIntensity}
            value={accentIntensity}
            options={[
              { id: 'soft', label: L.stAccentIntensitySoft },
              { id: 'normal', label: L.stAccentIntensityNormal },
              { id: 'vivid', label: L.stAccentIntensityVivid },
            ] as const}
            onChange={onSetAccentIntensity}
          />
        </Card>

        <Card>
          <ChoiceRow
            divider title={L.stGlassLabel} hint={L.stGlassHint} ariaLabel={L.stGlassLabel} value={glass}
            options={[
              { id: 'off', label: L.stGlassOff },
              { id: 'subtle', label: L.stGlassSubtle },
              { id: 'medium', label: L.stGlassMedium },
              { id: 'strong', label: L.stGlassStrong },
            ] as const}
            onChange={onSetGlass}
          />
          <ChoiceRow
            divider={false} title={L.stMotionLabel} ariaLabel={L.stMotionLabel} value={motionMode}
            options={[
              { id: 'system', label: L.stMotionSystem },
              { id: 'full', label: L.stMotionFull },
              { id: 'reduced', label: L.stMotionReduced },
            ] as const}
            onChange={onSetMotionMode}
          />
        </Card>
      </MScrollBody>
    </MScreen>
  );
}
