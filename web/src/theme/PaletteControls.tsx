// input:  palette presets, ColorSlider
// output: PaletteControls, PaletteControlsCopy
// pos:    Readable palette preset labels and exact color previews
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import type { CSSProperties } from 'react';
import { PALETTE_RANGES, type Palette, type PaletteKey } from './palette';
import { PALETTE_PRESETS, type PalettePreset } from './palette-presets';
import { DEFAULT_ACCENT_HUE } from './theme';
import { ColorSlider } from './ColorSlider';

export interface PaletteControlsCopy {
  presets: string;
  custom: string;
  reset: string;
  background: string;
  foreground: string;
  hue: string;
  tint: string;
  lightness: string;
  contrast: string;
  /** Display name per preset id; ids missing here fall back to the raw id. */
  presetNames: Record<string, string>;
}

// The chip preview is painted by the [data-preset-swatch] rule from these numbers; see public/theme.css.
function swatchVars(preset: PalettePreset): CSSProperties {
  return {
    '--sw-bg-hue': preset.palette.bgHue,
    '--sw-bg-chroma': preset.palette.bgChroma,
    '--sw-bg-light': preset.palette.bgLight,
    '--sw-ink-hue': preset.palette.inkHue,
    '--sw-ink-chroma': preset.palette.inkChroma,
    '--sw-ink-contrast': preset.palette.inkContrast,
    '--sw-accent-hue': preset.accentHue ?? DEFAULT_ACCENT_HUE,
    '--sw-accent-chroma': preset.accentIntensity === 'soft' ? 0.55
      : preset.accentIntensity === 'vivid' ? 1.45 : 1,
  } as CSSProperties;
}

function PresetSwatch({ preset }: { preset: PalettePreset }) {
  return <span aria-hidden data-preset-swatch style={{ ...swatchVars(preset), width: 18, height: 18,
    borderRadius: '50%', flex: 'none', boxShadow: '0 0 0 1px var(--proto-line-3)' }} />;
}

function PresetChip({ preset, label, active, onPick }: {
  preset: PalettePreset;
  label: string;
  active: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <button
      type="button"
      data-palette-preset={preset.id}
      aria-pressed={active}
      onClick={() => onPick(preset.id)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', border: 0,
        padding: '4px 9px 4px 5px', borderRadius: 'var(--r-control)', minHeight: 'var(--settings-control-height, 34px)', font: 'inherit', fontSize: 12, fontWeight: 600,
        background: active ? 'var(--proto-accent-bg)' : 'var(--proto-gray)',
        boxShadow: `0 0 0 1px ${active ? 'var(--proto-accent-border)' : 'var(--proto-line-2)'}`,
        color: active ? 'color-mix(in srgb, var(--proto-accent), var(--proto-ink) 15%)' : 'var(--proto-muted)',
      }}
    >
      <PresetSwatch preset={preset} />
      {label}
    </button>
  );
}

function PresetRow({ copy, activePreset, onPickPreset, onReset }: {
  copy: PaletteControlsCopy;
  activePreset: string | null;
  onPickPreset: (id: string) => void;
  onReset: () => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{copy.presets}</span>
        {activePreset === null && (
          <span style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{copy.custom}</span>
        )}
        <button
          type="button" data-palette-reset onClick={onReset}
          style={{
            // `font` must come first: as a shorthand it resets `font-size`, so declaring it after
            // the size silently threw the size away and this action rendered at the body scale.
            font: 'inherit', marginLeft: 'auto', border: 0, padding: 0, background: 'transparent',
            color: 'var(--proto-accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {copy.reset}
        </button>
      </div>
      <div role="group" aria-label={copy.presets} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {PALETTE_PRESETS.map((preset) => (
          <PresetChip
            key={preset.id}
            preset={preset}
            label={copy.presetNames[preset.id] ?? preset.id}
            active={activePreset === preset.id}
            onPick={onPickPreset}
          />
        ))}
      </div>
    </div>
  );
}

// Track background per parameter; hue reuses the accent spectrum so both hue sliders read alike.
const TRACKS: Record<PaletteKey, string> = {
  bgHue: 'var(--accent-spectrum)',
  bgChroma: 'var(--bg-chroma-track)',
  bgLight: 'var(--bg-light-track)',
  inkHue: 'var(--accent-spectrum)',
  inkChroma: 'var(--ink-chroma-track)',
  inkContrast: 'var(--ink-contrast-track)',
};

function ParamSlider({ paramKey, label, value, onChange }: {
  paramKey: PaletteKey;
  label: string;
  value: number;
  onChange: (key: PaletteKey, value: number) => void;
}) {
  const { min, max, step } = PALETTE_RANGES[paramKey];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 12, color: 'var(--proto-muted-2)', flex: '0 0 64px' }}>{label}</span>
      <ColorSlider min={min} max={max} step={step} value={value}
        data-palette-slider={paramKey} aria-label={label}
        onChange={(next) => onChange(paramKey, next)} track={TRACKS[paramKey]}
        style={{ flex: 1 }} />
    </div>
  );
}

function ParamGroup({ title, rows, palette, onChange }: {
  title: string;
  rows: { key: PaletteKey; label: string }[];
  palette: Palette;
  onChange: (key: PaletteKey, value: number) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', marginBottom: 9 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map((row) => (
          <ParamSlider
            key={row.key} paramKey={row.key} label={row.label}
            value={palette[row.key]} onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}

export function PaletteControls({ palette, copy, activePreset, onPickPreset, onChange, onReset }: {
  palette: Palette;
  copy: PaletteControlsCopy;
  activePreset: string | null;
  onPickPreset: (id: string) => void;
  onChange: (key: PaletteKey, value: number) => void;
  onReset: () => void;
}) {
  return (
    <div data-palette-controls style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PresetRow copy={copy} activePreset={activePreset} onPickPreset={onPickPreset} onReset={onReset} />
      <ParamGroup title={copy.background} palette={palette} onChange={onChange} rows={[
        { key: 'bgHue', label: copy.hue }, { key: 'bgChroma', label: copy.tint },
        { key: 'bgLight', label: copy.lightness },
      ]} />
      <ParamGroup title={copy.foreground} palette={palette} onChange={onChange} rows={[
        { key: 'inkHue', label: copy.hue }, { key: 'inkChroma', label: copy.tint },
        { key: 'inkContrast', label: copy.contrast },
      ]} />
    </div>
  );
}
