import { useNavigate } from 'react-router-dom';
import { useLang, useLangSource, useSetLang } from '@/i18n';
import {
  useAccentHue, useSetAccentHue,
  useAccentIntensity, useSetAccentIntensity,
  useMotionMode, useSetMotionMode,
  usePalette, useSetPaletteValue,
  useActivePreset, useApplyPreset, useResetPalette,
  useTheme, useSetTheme,
} from '@/theme';
import { pickCopy } from '@/mobile/ui/format';
import { MAppearanceView, type MAppearanceCopy } from './MAppearanceView';

const COPY: { en: MAppearanceCopy; zh: MAppearanceCopy } = {
  en: {
    title: 'Appearance',
    language: 'Language',
    languageHint: 'Also the language Cortex writes in — compaction notices, command replies. Saved on the server.',
    languageEnvPinned: 'Pinned by CORTEX_LANG: a change applies now but the variable wins again after a server restart.',
    theme: 'Theme', themeLight: 'Light', themeDark: 'Dark', themeSystem: 'System',
    palette: {
      presets: 'Presets', custom: 'custom', reset: 'Reset',
      background: 'Background', foreground: 'Foreground',
      hue: 'Hue', tint: 'Tint', lightness: 'Light', contrast: 'Contrast',
      presetNames: {
        default: 'Default', graphite: 'Graphite', sepia: 'Sepia', indigo: 'Indigo',
        forest: 'Forest', rose: 'Rose', deep: 'Deep',
      },
    },
    accent: 'Accent color', accentDefault: 'Default indigo', accentBlue: 'Blue', accentTeal: 'Teal',
    accentViolet: 'Violet', accentRose: 'Rose', accentOrange: 'Orange',
    accentCustom: 'Custom accent hue', accentReset: 'Reset',
    accentIntensity: 'Intensity', accentIntensitySoft: 'Soft',
    accentIntensityNormal: 'Normal', accentIntensityVivid: 'Vivid',
    motion: 'Motion', motionSystem: 'System', motionFull: 'Full', motionReduced: 'Reduced',
  },
  zh: {
    title: '外观',
    language: '语言',
    languageHint: '同时决定 Cortex 在对话里写的语言 —— 压缩提示、命令回执。保存在服务端。',
    languageEnvPinned: '被 CORTEX_LANG 固定：改动立即生效，但服务端重启后仍以环境变量为准。',
    theme: '主题', themeLight: '浅色', themeDark: '深色', themeSystem: '跟随系统',
    palette: {
      presets: '预设', custom: '自定义', reset: '恢复默认',
      background: '背景', foreground: '前景',
      hue: '色相', tint: '着色', lightness: '明度', contrast: '对比',
      presetNames: {
        default: '默认', graphite: '石墨', sepia: '暖褐', indigo: '靛青',
        forest: '森林', rose: '玫瑰', deep: '深邃',
      },
    },
    accent: '强调色', accentDefault: '默认靛蓝', accentBlue: '蓝色', accentTeal: '青色',
    accentViolet: '紫色', accentRose: '玫红', accentOrange: '橙色',
    accentCustom: '自定义强调色色相', accentReset: '恢复默认',
    accentIntensity: '浓度', accentIntensitySoft: '柔和',
    accentIntensityNormal: '标准', accentIntensityVivid: '鲜明',
    motion: '动效', motionSystem: '跟随系统', motionFull: '完整', motionReduced: '减弱',
  },
};

export function MAppearanceScreen() {
  const navigate = useNavigate();
  const lang = useLang();
  const langSource = useLangSource();
  const setLang = useSetLang();
  const theme = useTheme();
  const setTheme = useSetTheme();
  const palette = usePalette();
  const setPaletteValue = useSetPaletteValue();
  const activePreset = useActivePreset();
  const applyPreset = useApplyPreset();
  const resetPalette = useResetPalette();
  const accentHue = useAccentHue();
  const setAccentHue = useSetAccentHue();
  const accentIntensity = useAccentIntensity();
  const setAccentIntensity = useSetAccentIntensity();
  const motionMode = useMotionMode();
  const setMotionMode = useSetMotionMode();
  return (
    <MAppearanceView
      copy={pickCopy(lang, COPY)}
      lang={lang}
      langSource={langSource}
      onSetLang={setLang}
      theme={theme}
      onSetTheme={setTheme}
      palette={palette}
      onSetPaletteValue={setPaletteValue}
      activePreset={activePreset}
      onPickPreset={applyPreset}
      onResetPalette={resetPalette}
      accentHue={accentHue}
      onSetAccentHue={setAccentHue}
      accentIntensity={accentIntensity}
      onSetAccentIntensity={setAccentIntensity}
      motionMode={motionMode}
      onSetMotionMode={setMotionMode}
      onBack={() => navigate('/m/settings')}
    />
  );
}
