import { useVocab, type Lang, type LangSource, type Vocab } from '@/i18n';
import type { AccentPickerCopy, PaletteControlsCopy } from '@/theme';

// Appearance labels shared by the desktop panel and the mobile Appearance screen.

/** Palette control labels. */
export function usePaletteCopy(): PaletteControlsCopy {
  const L = useVocab();
  return {
    presets: L.stPalettePresets, custom: L.stPaletteCustom, reset: L.stPaletteReset,
    background: L.stPaletteBackground, foreground: L.stPaletteForeground,
    hue: L.stPaletteHue, tint: L.stPaletteTint,
    lightness: L.stPaletteLightness, contrast: L.stPaletteContrast,
    presetNames: {
      default: L.stPresetDefault, graphite: L.stPresetGraphite, sepia: L.stPresetSepia,
      indigo: L.stPresetIndigo, forest: L.stPresetForest, rose: L.stPresetRose,
      deep: L.stPresetDeep,
    },
  };
}

/** Accent picker labels. */
export function useAccentCopy(): AccentPickerCopy {
  const L = useVocab();
  return {
    label: L.stAccentLabel, default: L.stAccentDefault, blue: L.stAccentBlue,
    teal: L.stAccentTeal, violet: L.stAccentViolet, rose: L.stAccentRose,
    orange: L.stAccentOrange, custom: L.stAccentCustom, reset: L.stAccentReset,
  };
}

/** The language row's hint. CORTEX_LANG re-wins at boot, so say so rather than let the toggle
 *  look authoritative. */
export function languageHint(L: Vocab, source: LangSource | undefined): string {
  return source === 'env' ? `${L.stLangHint} ${L.stLangEnvPinned}` : L.stLangHint;
}

/** The language choices, labelled in their own language. */
export function languageOptions(L: Vocab): { id: Lang; label: string }[] {
  return [{ id: 'en', label: L.stLangEnglish }, { id: 'zh', label: L.stLangChinese }];
}
