// input:  palette parameters, preset table, localized labels
// output: Preset chips and background/foreground parameter sliders
// pos:    Shared desktop/mobile palette editor
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { CSSProperties } from 'react';
import { PALETTE_RANGES, type Palette, type PaletteKey } from './palette';
import { PALETTE_PRESETS, type PalettePreset } from './palette-presets';
import { DEFAULT_ACCENT_HUE } from './theme';

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

// The chip preview is painted by --preset-swatch from these numbers; see public/theme.css.
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
        display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
        padding: '4px 9px 4px 5px', borderRadius: 999, font: 'inherit', fontSize: 11, fontWeight: 600,
        background: active ? 'var(--proto-accent-bg)' : 'var(--proto-gray)',
        border: `1px solid ${active ? 'var(--proto-accent-border)' : 'var(--proto-line)'}`,
        color: active ? 'var(--proto-accent)' : 'var(--proto-muted)',
      }}
    >
      <span
        aria-hidden
        style={{
          ...swatchVars(preset), width: 16, height: 16, borderRadius: '50%', flex: 'none',
          background: 'var(--preset-swatch)', border: '1px solid var(--proto-line-3)',
        }}
      />
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
            marginLeft: 'auto', border: 0, padding: 0, background: 'transparent',
            color: 'var(--proto-muted-2)', fontSize: 10, cursor: 'pointer', font: 'inherit',
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
  const ratio = (value - min) / (max - min);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 11, color: 'var(--proto-muted-2)', flex: 'none', width: 34 }}>{label}</span>
      <div style={{ position: 'relative', height: 14, flex: 1, minWidth: 0 }}>
        <div style={{ position: 'absolute', top: 5, left: 0, right: 0, height: 4, borderRadius: 999, background: TRACKS[paramKey] }} />
        <span
          aria-hidden
          style={{
            position: 'absolute', top: 0, left: `calc(${ratio * 100}% - 7px)`,
            width: 14, height: 14, borderRadius: '50%', background: 'var(--proto-card)',
            border: '2px solid var(--proto-ink)', boxShadow: 'var(--shadow-switch-thumb)',
            pointerEvents: 'none',
          }}
        />
        <input
          type="range" min={min} max={max} step={step} value={value}
          data-palette-slider={paramKey} aria-label={label}
          onChange={(event) => onChange(paramKey, Number(event.target.value))}
          style={{ position: 'absolute', inset: 0, width: '100%', height: 14, margin: 0, opacity: 0, cursor: 'pointer' }}
        />
      </div>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
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
      <ParamGroup
        title={copy.background}
        palette={palette}
        onChange={onChange}
        rows={[
          { key: 'bgHue', label: copy.hue },
          { key: 'bgChroma', label: copy.tint },
          { key: 'bgLight', label: copy.lightness },
        ]}
      />
      <ParamGroup
        title={copy.foreground}
        palette={palette}
        onChange={onChange}
        rows={[
          { key: 'inkHue', label: copy.hue },
          { key: 'inkChroma', label: copy.tint },
          { key: 'inkContrast', label: copy.contrast },
        ]}
      />
    </div>
  );
}
