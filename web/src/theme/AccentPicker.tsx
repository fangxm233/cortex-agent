// input:  Accent hue value, localized labels, shared palette tokens
// output: Accessible preset swatches, hue slider, and reset control
// pos:    Shared desktop/mobile accent color picker
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { CSSProperties } from 'react';
import { DEFAULT_ACCENT_HUE, type AccentHue } from './theme';

export interface AccentPickerCopy {
  label: string;
  default: string;
  blue: string;
  teal: string;
  violet: string;
  rose: string;
  orange: string;
  custom: string;
  reset: string;
}

const PRESETS = [
  { id: 'blue', hue: 255, color: 'var(--accent-swatch-blue)' },
  { id: 'teal', hue: 190, color: 'var(--accent-swatch-teal)' },
  { id: 'violet', hue: 305, color: 'var(--accent-swatch-violet)' },
  { id: 'rose', hue: 10, color: 'var(--accent-swatch-rose)' },
  { id: 'orange', hue: 55, color: 'var(--accent-swatch-orange)' },
] as const;

type Preset = (typeof PRESETS)[number];

function SwatchButton({ active, color, label, id, onClick, size }: {
  active: boolean;
  color: string;
  label: string;
  id: string;
  onClick: () => void;
  size: number;
}) {
  return (
    <button
      type="button"
      data-accent-preset={id}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      style={{
        width: size, height: size, padding: 3, borderRadius: '50%', cursor: 'pointer',
        border: active ? '2px solid var(--proto-ink)' : '2px solid transparent',
        background: 'transparent', flex: 'none',
      }}
    >
      <span style={{ display: 'block', width: '100%', height: '100%', borderRadius: '50%', background: color }} />
    </button>
  );
}

function PresetSwatches({ hue, copy, onChange, size }: {
  hue: AccentHue;
  copy: AccentPickerCopy;
  onChange: (hue: AccentHue) => void;
  size: number;
}) {
  const renderPreset = (preset: Preset) => (
    <SwatchButton
      key={preset.id}
      id={preset.id}
      active={hue === preset.hue}
      color={preset.color}
      label={copy[preset.id]}
      onClick={() => onChange(preset.hue)}
      size={size}
    />
  );
  return (
    <div role="group" aria-label={copy.label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
      <SwatchButton active={hue === null} color="var(--accent-default-swatch)" label={copy.default} id="default" onClick={() => onChange(null)} size={size} />
      {PRESETS.map(renderPreset)}
    </div>
  );
}

function HueSlider({ hue, copy, onChange }: {
  hue: AccentHue;
  copy: AccentPickerCopy;
  onChange: (hue: AccentHue) => void;
}) {
  const value = hue ?? DEFAULT_ACCENT_HUE;
  const thumbStyle: CSSProperties = {
    position: 'absolute', top: 0, left: `calc(${(value / 359) * 100}% - 7px)`,
    width: 14, height: 14, borderRadius: '50%', background: 'var(--accent-main)',
    border: '2px solid var(--proto-card)', boxShadow: 'var(--shadow-switch-thumb)', pointerEvents: 'none',
  };
  return (
    <div style={{ position: 'relative', height: 14, marginTop: 8 }}>
      <div style={{ position: 'absolute', top: 5, left: 0, right: 0, height: 4, borderRadius: 999, background: 'var(--accent-spectrum)' }} />
      <span style={thumbStyle} />
      <input
        type="range" min={0} max={359} value={value}
        data-accent-hue-slider aria-label={copy.custom}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ position: 'absolute', inset: 0, width: '100%', height: 14, margin: 0, opacity: 0, cursor: 'pointer' }}
      />
    </div>
  );
}

export function AccentPicker({ hue, copy, onChange, compact = false }: {
  hue: AccentHue;
  copy: AccentPickerCopy;
  onChange: (hue: AccentHue) => void;
  compact?: boolean;
}) {
  return (
    <div data-accent-picker style={{ width: compact ? '100%' : 330, maxWidth: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PresetSwatches hue={hue} copy={copy} onChange={onChange} size={compact ? 27 : 29} />
        {hue !== null && (
          <button type="button" data-accent-reset onClick={() => onChange(null)} style={{ marginLeft: 'auto', border: 0, padding: 0, background: 'transparent', color: 'var(--proto-muted-2)', fontSize: 10, cursor: 'pointer' }}>
            {copy.reset}
          </button>
        )}
      </div>
      <HueSlider hue={hue} copy={copy} onChange={onChange} />
    </div>
  );
}
