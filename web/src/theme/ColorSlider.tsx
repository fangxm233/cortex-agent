// input:  react, theme color tokens
// output: ColorSlider
// pos:    Keyboard and touch control for appearance colors
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import type { CSSProperties, InputHTMLAttributes } from 'react';
import './color-slider.css';

type ColorSliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> & {
  track: string;
  thumb?: string;
  onChange: (value: number) => void;
};

export function ColorSlider({ track, thumb = 'var(--proto-card)', onChange, style, ...props }: ColorSliderProps) {
  const colors = { '--color-slider-track': track, '--color-slider-thumb': thumb } as CSSProperties;
  return (
    <input {...props} type="range" className="appearance-color-slider"
      onChange={(event) => onChange(Number(event.target.value))}
      style={{ ...colors, ...style }} />
  );
}
