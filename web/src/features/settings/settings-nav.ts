// Pure nav model for the Settings modal (design 12a–g, prototype.dc.html L720–1090, script L2379).
// The 9 left-nav panels + their content-header title/sub copy.
// Labels are i18n keys resolved via `getSettingsNav(L)` / `getSectionMeta(L, key)`.
// Framework-free; no JSX, no hex. Precedent: features/overview/overview-vm.ts.

import type { Vocab } from '@/i18n';

export type SettingsSectionKey =
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
  platform: '.env',
  profiles: 'profiles.json',
  budget: 'budget.json',
  machines: 'machines.json',
  templates: 'thread-templates',
  mcp: 'mcp-config.json',
  notifications: '.env',
  hooks: 'hooks/*.mjs',
  advanced: 'feature flags',
};

// prototype L2379–2388 — order is authoritative.
const NAV_ORDER: SettingsSectionKey[] = [
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

// ── Legacy exports (hardcoded EN) for tests that don't wire a Vocab ──
// These exist only for backward compat with tests that check raw label strings.
// New code should use getSettingsNav(L) / getSectionMeta(L, key).

import { en } from '@/i18n';

export const SETTINGS_NAV: SettingsNavEntry[] = getSettingsNav(en);
export const SETTINGS_SECTION_META: Record<SettingsSectionKey, SettingsSectionMeta> =
  Object.fromEntries(NAV_ORDER.map((k) => [k, getSectionMeta(en, k)])) as Record<
    SettingsSectionKey,
    SettingsSectionMeta
  >;

export function sectionMeta(key: SettingsSectionKey): SettingsSectionMeta {
  return getSectionMeta(en, key);
}
