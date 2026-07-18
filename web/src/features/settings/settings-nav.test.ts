import { describe, it, expect } from 'vitest';
import { SETTINGS_NAV, SETTINGS_SECTION_META, getSettingsNav, getSectionMeta } from './settings-nav';
import { en } from '@/i18n';

describe('settings-nav', () => {
  it('lists the panels in order — Appearance first, then the prototype order (L2379–2388)', () => {
    expect(SETTINGS_NAV.map((n) => n.key)).toEqual([
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
    ]);
  });

  it('carries the exact label + file tag for each panel (en)', () => {
    const byKey = Object.fromEntries(SETTINGS_NAV.map((n) => [n.key, n]));
    expect(byKey.platform).toMatchObject({ label: 'Platform', file: '.env' });
    expect(byKey.templates).toMatchObject({ label: 'Thread templates', file: 'thread-templates' });
    expect(byKey.mcp).toMatchObject({ label: 'MCP servers', file: 'mcp-config.json' });
    expect(byKey.hooks).toMatchObject({ label: 'Hooks', file: 'hooks/*.mjs' });
    expect(byKey.advanced).toMatchObject({ label: 'Advanced', file: 'feature flags' });
  });

  it('getSettingsNav returns translated entries', () => {
    const nav = getSettingsNav(en);
    expect(nav.length).toBe(10);
    expect(nav[0].label).toBe('Appearance');
    expect(nav[1].label).toBe('Platform');
    expect(nav[9].label).toBe('Advanced');
  });

  it('getSectionMeta returns translated title + sub', () => {
    const meta = getSectionMeta(en, 'budget');
    expect(meta.title).toBe('Budget');
    expect(meta.sub).toContain('hot-read, applies immediately');
  });

  it('has section meta for every nav key with verbatim EN copy', () => {
    for (const n of SETTINGS_NAV) {
      expect(SETTINGS_SECTION_META[n.key]).toBeDefined();
    }
    const budget = SETTINGS_SECTION_META.budget;
    expect(budget.sub).toContain('hot-read, applies immediately');
    const platform = SETTINGS_SECTION_META.platform;
    expect(platform.sub).toContain('the only restart-required config');
  });
});
