import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useNavigate } from 'react-router-dom';
import { useLang, useLangSource, useSetLang } from '@/i18n';
import {
  useAccentHue, useSetAccentHue,
  useAccentIntensity, useSetAccentIntensity,
  useGlass, useSetGlass,
  useMotionMode, useSetMotionMode,
  usePalette, useSetPaletteValue,
  useActivePreset, useApplyPreset, useResetPalette,
  useTheme, useSetTheme,
} from '@/theme';
import { setWorkLogMode, useWorkLogMode } from '@/features/session/transcript/work-log-pref';
import { MAppearanceView } from './MAppearanceView';

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
  const glass = useGlass();
  const setGlass = useSetGlass();
  const motionMode = useMotionMode();
  const setMotionMode = useSetMotionMode();
  const workLogMode = useWorkLogMode();
  return (
    <MAppearanceView
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
      glass={glass}
      onSetGlass={setGlass}
      motionMode={motionMode}
      onSetMotionMode={setMotionMode}
      workLogMode={workLogMode}
      onSetWorkLogMode={setWorkLogMode}
      onBack={() => mobileHeaderBack(navigate, '/m/settings')}
    />
  );
}
