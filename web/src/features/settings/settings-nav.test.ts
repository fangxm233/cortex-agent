import { describe, expect, it } from 'vitest';
import { en, zh } from '@/i18n';
import { getSectionTitle, getSettingsNavGroups, getSettingsNavIcon } from './settings-nav';

describe('settings nav', () => {
  it('lists Stats under Resources right after Usage', () => {
    const resources = getSettingsNavGroups(en).find((group) => group.key === 'resources');
    expect(resources?.entries.map((entry) => entry.key)).toEqual(['budget', 'usage', 'stats', 'machines']);
  });

  it('titles Stats from the vocab and gives it its own glyph', () => {
    expect(getSectionTitle(en, 'stats')).toBe(en.stNavStats);
    expect(getSectionTitle(zh, 'stats')).toBe('统计');
    expect(getSettingsNavIcon('stats')).toMatch(/^M/);
    expect(getSettingsNavIcon('stats')).not.toBe(getSettingsNavIcon('usage'));
  });
});
