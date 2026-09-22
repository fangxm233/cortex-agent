// input:  theme tokens, ColorSlider
// output: AccentPicker, AccentPickerCopy
// pos:    Appearance accent presets and hue control
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { ColorSlider } from './ColorSlider';
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
        border: '2px solid transparent',
        boxShadow: active ? 'inset 0 0 0 1.5px var(--proto-accent)' : 'none',
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
    <div role="group" aria-label={copy.label} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
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
  return (
    <ColorSlider min={0} max={359} value={hue ?? DEFAULT_ACCENT_HUE}
      data-accent-hue-slider aria-label={copy.custom} onChange={onChange}
      track="var(--accent-spectrum)" thumb="var(--accent-main)" />
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
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <PresetSwatches hue={hue} copy={copy} onChange={onChange} size={compact ? 40 : 32} />
        {hue !== null && (
          <button type="button" data-accent-reset onClick={() => onChange(null)} style={{ marginLeft: 'auto', border: 0, padding: 0, background: 'transparent', color: 'var(--proto-muted-2)', fontSize: 12, minHeight: 34, cursor: 'pointer' }}>
            {copy.reset}
          </button>
        )}
      </div>
      <HueSlider hue={hue} copy={copy} onChange={onChange} />
    </div>
  );
}
