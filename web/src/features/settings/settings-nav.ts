// input:  vocab
// output: grouped settings navigation — keys, labels, icons, per-section icon and section meta
// pos:    Single source for the desktop settings nav and the mobile settings list
// >>> Once updated, update this header and parent AGENTS.md <<<

import type { Vocab } from '@/i18n';

export type SettingsSectionKey =
  | 'appearance'
  | 'platform'
  | 'accounts'
  | 'profiles'
  | 'budget'
  | 'usage'
  | 'machines'
  | 'templates'
  | 'plugins'
  | 'mcp'
  | 'notifications'
  | 'hooks'
  | 'advanced';

export type SettingsGroupKey = 'workspace' | 'agent' | 'resources' | 'system';

export interface SettingsNavEntry {
  key: SettingsSectionKey;
  label: string;
  /** 24×24 stroked path data. Rendered at 15px beside the label. */
  icon: string;
}

export interface SettingsNavGroup {
  key: SettingsGroupKey;
  label: string;
  entries: SettingsNavEntry[];
}

export interface SettingsSectionMeta {
  /** Content-area title. */
  title: string;
  /** Content-area sub-line. */
  sub: string;
}

// Vocab key for each nav label (also used as section meta title).
const NAV_LABEL_KEYS: Record<SettingsSectionKey, keyof Vocab> = {
  appearance: 'stNavAppearance',
  platform: 'stNavPlatform',
  accounts: 'stNavAccounts',
  profiles: 'stNavProfiles',
  budget: 'stNavBudget',
  usage: 'stNavUsage',
  machines: 'stNavMachines',
  templates: 'stNavTemplates',
  plugins: 'stNavPlugins',
  mcp: 'stNavMcp',
  notifications: 'stNavNotifications',
  hooks: 'stNavHooks',
  advanced: 'stNavAdvanced',
};

// Vocab key for each section meta sub description.
const NAV_SUB_KEYS: Record<SettingsSectionKey, keyof Vocab> = {
  appearance: 'stMetaAppearanceSub',
  platform: 'stMetaPlatformSub',
  accounts: 'stMetaAccountsSub',
  profiles: 'stMetaProfilesSub',
  budget: 'stMetaBudgetSub',
  usage: 'stMetaUsageSub',
  machines: 'stMetaMachinesSub',
  templates: 'stMetaTemplatesSub',
  plugins: 'stMetaPluginsSub',
  mcp: 'stMetaMcpSub',
  notifications: 'stMetaNotificationsSub',
  hooks: 'stMetaHooksSub',
  advanced: 'stMetaAdvancedSub',
};

// One stroked glyph per section, drawn on a 24×24 grid so they share a weight and optical size. The
// set is deliberately literal — a bell for notifications, a rack for machines — because the nav is
// scanned, not read, and a clever metaphor costs a fixation.
const NAV_ICONS: Record<SettingsSectionKey, string> = {
  appearance: 'M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.6-.3-1-.6-1.4-.3-.4-.4-.7-.4-1.1 0-1.1.9-2 2-2h1.6a4.4 4.4 0 0 0 4.4-4.4C21 6.2 17 3 12 3zM7.5 10.5h.01M10.5 7.5h.01M15.5 7.5h.01',
  accounts: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  platform: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.3 12h17.4M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18',
  notifications: 'M18 8.5a6 6 0 1 0-12 0c0 6.5-2.5 7.5-2.5 7.5h17S18 15 18 8.5M13.7 19.5a2 2 0 0 1-3.4 0',
  profiles: 'M4 7h9M17 7h3M4 17h3M11 17h9M14.5 4.2v5.6M7.5 14.2v5.6',
  templates: 'M12 3 3 7.5l9 4.5 9-4.5zM3 12l9 4.5L21 12M3 16.5 12 21l9-4.5',
  plugins: 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z',
  mcp: 'M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3zM9 9h6v6H9zM12 4V2M12 22v-2M4 12H2M22 12h-2',
  hooks: 'M9.5 17H7.5a5 5 0 0 1 0-10h2M14.5 7h2a5 5 0 0 1 0 10h-2M8.5 12h7',
  budget: 'M3.5 8.5a2 2 0 0 1 2-2h11M3.5 8.5v8a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-13a2 2 0 0 1-2-2zM16.8 13.5h.01',
  usage: 'M3.34 19a10 10 0 1 1 17.32 0M12 14l4-4',
  machines: 'M4 4.5h16v5.5H4zM4 14h16v5.5H4zM7.5 7.2h.01M7.5 16.8h.01M11 7.2h5M11 16.8h5',
  advanced: 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z',
};

// Vocab key per group heading.
const GROUP_LABEL_KEYS: Record<SettingsGroupKey, keyof Vocab> = {
  workspace: 'stGroupWorkspace',
  agent: 'stGroupAgent',
  resources: 'stGroupResources',
  system: 'stGroupSystem',
};

// Grouping follows what a section is *about*, not which file backs it: the four surfaces the user
// looks at and types into, the five that configure how the agent runs, the three that account for
// what it consumes, and the one escape hatch. Order inside a group is most- to least-visited.
const NAV_GROUPS: { key: SettingsGroupKey; keys: SettingsSectionKey[] }[] = [
  { key: 'workspace', keys: ['appearance', 'accounts', 'platform', 'notifications'] },
  { key: 'agent', keys: ['profiles', 'templates', 'plugins', 'mcp', 'hooks'] },
  { key: 'resources', keys: ['budget', 'usage', 'machines'] },
  { key: 'system', keys: ['advanced'] },
];

function navEntry(L: Vocab, key: SettingsSectionKey): SettingsNavEntry {
  return { key, label: L[NAV_LABEL_KEYS[key]], icon: NAV_ICONS[key] };
}

/** Returns one section's glyph, for entries outside the nav that open straight into that section. */
export function getSettingsNavIcon(key: SettingsSectionKey): string {
  return NAV_ICONS[key];
}

/** Returns the nav as grouped sections, in display order. */
export function getSettingsNavGroups(L: Vocab): SettingsNavGroup[] {
  return NAV_GROUPS.map((group) => ({
    key: group.key,
    label: L[GROUP_LABEL_KEYS[group.key]],
    entries: group.keys.map((key) => navEntry(L, key)),
  }));
}

/** Returns every nav entry flattened, in the same order the groups present them. */
export function getSettingsNav(L: Vocab): SettingsNavEntry[] {
  return NAV_GROUPS.flatMap((group) => group.keys.map((key) => navEntry(L, key)));
}

/** Returns section meta (title + sub) resolved from the given vocab. */
export function getSectionMeta(L: Vocab, key: SettingsSectionKey): SettingsSectionMeta {
  return {
    title: L[NAV_LABEL_KEYS[key]],
    sub: L[NAV_SUB_KEYS[key]],
  };
}
