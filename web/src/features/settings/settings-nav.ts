// input:  localized vocabulary and selected settings section
// output: ordered settings navigation and section metadata
// pos:    Pure navigation model for the Settings modal
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Labels are resolved via `getSettingsNav(L)` / `getSectionMeta(L, key)`.

import type { Vocab } from '@/i18n';

export type SettingsSectionKey =
  | 'appearance'
  | 'platform'
  | 'profiles'
  | 'budget'
  | 'machines'
  | 'templates'
  | 'mcp'
  | 'notifications'
  | 'hooks'
  | 'advanced';

export interface SettingsNavEntry {
  key: SettingsSectionKey;
  label: string;
  /** The mono file tag shown right-aligned in the nav row (prototype `n.file`). */
  file: string;
}

export interface SettingsSectionMeta {
  /** Content-area title (prototype `setTitle`). */
  title: string;
  /** Content-area sub-line (prototype `setSub`). */
  sub: string;
}

// Vocab key for each nav label (also used as section meta title).
const NAV_LABEL_KEYS: Record<SettingsSectionKey, keyof Vocab> = {
  appearance: 'stNavAppearance',
  platform: 'stNavPlatform',
  profiles: 'stNavProfiles',
  budget: 'stNavBudget',
  machines: 'stNavMachines',
  templates: 'stNavTemplates',
  mcp: 'stNavMcp',
  notifications: 'stNavNotifications',
  hooks: 'stNavHooks',
  advanced: 'stNavAdvanced',
};

// Vocab key for each section meta sub description.
const NAV_SUB_KEYS: Record<SettingsSectionKey, keyof Vocab> = {
  appearance: 'stMetaAppearanceSub',
  platform: 'stMetaPlatformSub',
  profiles: 'stMetaProfilesSub',
  budget: 'stMetaBudgetSub',
  machines: 'stMetaMachinesSub',
  templates: 'stMetaTemplatesSub',
  mcp: 'stMetaMcpSub',
  notifications: 'stMetaNotificationsSub',
  hooks: 'stMetaHooksSub',
  advanced: 'stMetaAdvancedSub',
};

// File tags (prototype order). These are file paths — not translated.
const NAV_FILES: Record<SettingsSectionKey, string> = {
  appearance: 'this device',
  platform: '.env',
  profiles: 'profiles.json',
  budget: 'budget.json',
  machines: 'machines.json',
  templates: 'thread-templates',
  mcp: 'mcp-config.json',
  notifications: '.env',
  hooks: 'config/hooks',
  advanced: 'feature flags',
};

// prototype L2379–2388 — order is authoritative.
const NAV_ORDER: SettingsSectionKey[] = [
  'appearance',
  'platform',
  'profiles',
  'budget',
  'machines',
  'templates',
  'mcp',
  'notifications',
  'hooks',
  'advanced',
];

/** Returns the 9 nav entries with labels resolved from the given vocab. */
export function getSettingsNav(L: Vocab): SettingsNavEntry[] {
  return NAV_ORDER.map((key) => ({
    key,
    label: L[NAV_LABEL_KEYS[key]],
    file: NAV_FILES[key],
  }));
}

/** Returns section meta (title + sub) resolved from the given vocab. */
export function getSectionMeta(L: Vocab, key: SettingsSectionKey): SettingsSectionMeta {
  return {
    title: L[NAV_LABEL_KEYS[key]],
    sub: L[NAV_SUB_KEYS[key]],
  };
}
