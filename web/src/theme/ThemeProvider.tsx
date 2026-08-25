// input:  React context, persisted appearance helpers, system scheme
// output: ThemeProvider and hooks for theme, palette, accent, and motion
// pos:    React owner for global device-local appearance state
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyAccentHue,
  applyAccentIntensity,
  applyMotionMode,
  applyTheme,
  readStoredAccentHue,
  readStoredAccentIntensity,
  readStoredMotionMode,
  readStoredTheme,
  storeAccentHue,
  storeAccentIntensity,
  storeMotionMode,
  storeTheme,
  watchSystemTheme,
  DEFAULT_ACCENT_HUE,
  type AccentHue,
  type AccentIntensity,
  type MotionMode,
  type Theme,
} from './theme';
import {
  applyPalette,
  readStoredPalette,
  storePalette,
  DEFAULT_PALETTE,
  type Palette,
  type PaletteKey,
} from './palette';
import { PALETTE_PRESETS, matchPreset } from './palette-presets';

interface ThemeContextValue {
  theme: Theme;
  accentHue: AccentHue;
  accentIntensity: AccentIntensity;
  palette: Palette;
  /** Id of the preset the current colour state matches exactly, else `null` (custom). */
  activePreset: string | null;
  motionMode: MotionMode;
  setTheme: (theme: Theme) => void;
  setAccentHue: (hue: AccentHue) => void;
  setAccentIntensity: (intensity: AccentIntensity) => void;
  setPaletteValue: (key: PaletteKey, value: number) => void;
  applyPreset: (id: string) => void;
  resetPalette: () => void;
  setMotionMode: (mode: MotionMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function useThemePreference() {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    return watchSystemTheme((prefersDark) => applyTheme('system', prefersDark));
  }, [theme]);
  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    storeTheme(next);
    applyTheme(next);
  }, []);
  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      storeTheme(next);
      applyTheme(next);
      return next;
    });
  }, []);
  return { theme, setTheme, toggleTheme };
}

// Hue and intensity move together: intensity only reaches the `data-accent='custom'` palette, while
// the built-in indigo is a fixed brand color. So raising or lowering intensity adopts the default hue
// as a custom accent, and returning to the built-in accent puts intensity back to `normal` — otherwise
// the intensity control would silently do nothing.
function useAccentPreference() {
  const [accentHue, setAccentHueState] = useState<AccentHue>(readStoredAccentHue);
  const [accentIntensity, setAccentIntensityState] = useState<AccentIntensity>(readStoredAccentIntensity);
  useEffect(() => applyAccentHue(accentHue), [accentHue]);
  useEffect(() => applyAccentIntensity(accentIntensity), [accentIntensity]);

  const commitHue = useCallback((next: AccentHue) => {
    setAccentHueState(next);
    storeAccentHue(next);
    applyAccentHue(next);
  }, []);
  const commitIntensity = useCallback((next: AccentIntensity) => {
    setAccentIntensityState(next);
    storeAccentIntensity(next);
    applyAccentIntensity(next);
  }, []);

  const setAccentHue = useCallback((next: AccentHue) => {
    commitHue(next);
    if (next === null) commitIntensity('normal');
  }, [commitHue, commitIntensity]);
  const setAccentIntensity = useCallback((next: AccentIntensity) => {
    commitIntensity(next);
    if (next !== 'normal' && accentHue === null) commitHue(DEFAULT_ACCENT_HUE);
  }, [accentHue, commitHue, commitIntensity]);

  return { accentHue, accentIntensity, setAccentHue, setAccentIntensity };
}

function usePalettePreference() {
  const [palette, setPaletteState] = useState<Palette>(readStoredPalette);
  useEffect(() => applyPalette(palette), [palette]);
  const commitPalette = useCallback((next: Palette) => {
    setPaletteState(next);
    storePalette(next);
    applyPalette(next);
  }, []);
  const setPaletteValue = useCallback((key: PaletteKey, value: number) => {
    setPaletteState((prev) => {
      const next = { ...prev, [key]: value };
      storePalette(next);
      applyPalette(next);
      return next;
    });
  }, []);
  return { palette, commitPalette, setPaletteValue };
}

function useMotionPreference() {
  const [motionMode, setMotionModeState] = useState<MotionMode>(readStoredMotionMode);
  useEffect(() => applyMotionMode(motionMode), [motionMode]);
  const setMotionMode = useCallback((next: MotionMode) => {
    setMotionModeState(next);
    storeMotionMode(next);
    applyMotionMode(next);
  }, []);
  return { motionMode, setMotionMode };
}

// The no-flash script applies initial preferences before React mounts; this provider owns changes.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const themePreference = useThemePreference();
  const accentPreference = useAccentPreference();
  const palettePreference = usePalettePreference();
  const motionPreference = useMotionPreference();
  const { commitPalette, palette, setPaletteValue } = palettePreference;
  const { accentHue, accentIntensity, setAccentHue, setAccentIntensity } = accentPreference;

  // A preset is the whole colour state, so it writes palette and accent together rather than
  // leaving the accent behind at whatever the previous preset chose.
  const applyPreset = useCallback((id: string) => {
    const preset = PALETTE_PRESETS.find((entry) => entry.id === id);
    if (!preset) return;
    commitPalette({ ...preset.palette });
    setAccentIntensity(preset.accentIntensity);
    setAccentHue(preset.accentHue);
  }, [commitPalette, setAccentHue, setAccentIntensity]);

  const resetPalette = useCallback(() => commitPalette({ ...DEFAULT_PALETTE }), [commitPalette]);
  const activePreset = matchPreset(palette, accentHue, accentIntensity);

  const value = useMemo<ThemeContextValue>(
    () => ({
      ...themePreference, ...accentPreference, ...motionPreference,
      palette, setPaletteValue, applyPreset, resetPalette, activePreset,
    }),
    [themePreference.theme, themePreference.setTheme, themePreference.toggleTheme,
      accentHue, setAccentHue, accentIntensity, setAccentIntensity,
      palette, setPaletteValue, applyPreset, resetPalette, activePreset,
      motionPreference.motionMode, motionPreference.setMotionMode],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}

export function useAccentHue(): AccentHue {
  return useThemeContext().accentHue;
}

export function useSetTheme(): (theme: Theme) => void {
  return useThemeContext().setTheme;
}

export function useSetAccentHue(): (hue: AccentHue) => void {
  return useThemeContext().setAccentHue;
}

export function useAccentIntensity(): AccentIntensity {
  return useThemeContext().accentIntensity;
}

export function useSetAccentIntensity(): (intensity: AccentIntensity) => void {
  return useThemeContext().setAccentIntensity;
}

export function usePalette(): Palette {
  return useThemeContext().palette;
}

export function useSetPaletteValue(): (key: PaletteKey, value: number) => void {
  return useThemeContext().setPaletteValue;
}

export function useActivePreset(): string | null {
  return useThemeContext().activePreset;
}

export function useApplyPreset(): (id: string) => void {
  return useThemeContext().applyPreset;
}

export function useResetPalette(): () => void {
  return useThemeContext().resetPalette;
}

export function useMotionMode(): MotionMode {
  return useThemeContext().motionMode;
}

export function useSetMotionMode(): (mode: MotionMode) => void {
  return useThemeContext().setMotionMode;
}

export function useToggleTheme(): () => void {
  return useThemeContext().toggleTheme;
}
