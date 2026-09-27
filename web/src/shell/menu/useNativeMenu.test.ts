import { describe, expect, it } from 'vitest';
import { en, zh } from '@/i18n';
import { appMenuLabels } from './useNativeMenu';

describe('appMenuLabels', () => {
  it('words the macOS application menu the shell builds itself', () => {
    expect(appMenuLabels(zh)).toEqual({
      about: '关于 Cortex', services: '服务', hide: '隐藏 Cortex',
      hideOthers: '隐藏其他', showAll: '全部显示', quit: '退出 Cortex',
    });
    expect(appMenuLabels(en).quit).toBe('Quit Cortex');
  });
});
