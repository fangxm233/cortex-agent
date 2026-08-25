// input:  ThemeProvider, AccentPicker, appearance utilities
// output: Public theme controls and preference API
// pos:    Theme package barrel
// >>> If I am updated, update my header comment and CORTEX.md <<<

export { AccentPicker, type AccentPickerCopy } from './AccentPicker';
export {
  ThemeProvider,
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
  useTheme,
  useSetTheme,
  useToggleTheme,
} from './ThemeProvider';
export {
  applyAccentHue,
  applyAccentIntensity,
  applyMotionMode,
  applyTheme,
  parseStoredAccentHue,
  parseStoredAccentIntensity,
  parseStoredMotionMode,
  readStoredAccentHue,
  readStoredAccentIntensity,
  readStoredMotionMode,
  readStoredTheme,
  storeAccentHue,
  storeAccentIntensity,
  storeMotionMode,
  storeTheme,
  resolveInitialTheme,
  ACCENT_HUE_STORAGE_KEY,
  ACCENT_INTENSITY_STORAGE_KEY,
  MOTION_STORAGE_KEY,
  DEFAULT_ACCENT_HUE,
  DEFAULT_ACCENT_INTENSITY,
  DEFAULT_MOTION_MODE,
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  type AccentHue,
  type AccentIntensity,
  type MotionMode,
  type Theme,
} from './theme';
export {
  clampPalette,
  isDefaultPalette,
  parseStoredPalette,
  readStoredPalette,
  storePalette,
  applyPalette,
  DEFAULT_PALETTE,
  PALETTE_KEYS,
  PALETTE_RANGES,
  PALETTE_STORAGE_KEY,
  type Palette,
  type PaletteKey,
  type PaletteRange,
} from './palette';
export { PALETTE_PRESETS, matchPreset, type PalettePreset } from './palette-presets';
export { PaletteControls, type PaletteControlsCopy } from './PaletteControls';
