// input:  ThemeProvider, AccentPicker, appearance utilities
// output: Public theme controls and preference API
// pos:    Theme package barrel
// >>> If I am updated, update my header comment and CORTEX.md <<<

export { AccentPicker, type AccentPickerCopy } from './AccentPicker';
export {
  ThemeProvider,
  useAccentHue,
  useSetAccentHue,
  useTheme,
  useSetTheme,
  useToggleTheme,
} from './ThemeProvider';
export {
  applyAccentHue,
  applyTheme,
  parseStoredAccentHue,
  readStoredAccentHue,
  readStoredTheme,
  storeAccentHue,
  storeTheme,
  resolveInitialTheme,
  ACCENT_HUE_STORAGE_KEY,
  DEFAULT_ACCENT_HUE,
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  type AccentHue,
  type Theme,
} from './theme';
