// input:  appearance providers, language state, and navigation
// output: mobile appearance drill-in bound to the device-local theme state
// pos:    Mobile appearance routing container
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useNavigate } from 'react-router-dom';
import { useLang, useSetLang } from '@/i18n';
import {
  useAccentHue, useSetAccentHue,
  useAccentIntensity, useSetAccentIntensity,
  useMotionMode, useSetMotionMode,
  useSurfaceTone, useSetSurfaceTone,
  useTheme, useSetTheme,
} from '@/theme';
import { pickCopy } from '@/mobile/ui/format';
import { MAppearanceView, type MAppearanceCopy } from './MAppearanceView';

const COPY: { en: MAppearanceCopy; zh: MAppearanceCopy } = {
  en: {
    title: 'Appearance',
    language: 'Language',
    theme: 'Theme', themeLight: 'Light', themeDark: 'Dark', themeSystem: 'System',
    surface: 'Background', surfaceDefault: 'Default', surfaceNeutral: 'Neutral', surfaceContrast: 'Contrast',
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
    theme: '主题', themeLight: '浅色', themeDark: '深色', themeSystem: '跟随系统',
    surface: '底色', surfaceDefault: '默认', surfaceNeutral: '中性', surfaceContrast: '高对比',
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
  const setLang = useSetLang();
  const theme = useTheme();
  const setTheme = useSetTheme();
  const surfaceTone = useSurfaceTone();
  const setSurfaceTone = useSetSurfaceTone();
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
      onSetLang={setLang}
      theme={theme}
      onSetTheme={setTheme}
      surfaceTone={surfaceTone}
      onSetSurfaceTone={setSurfaceTone}
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
