// input:  env and runtime-setting snapshot fixtures
// output: settings-panel source-selection regressions
// pos:    Verifies secret redaction and settings snapshot indexing
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { ConfigEnvEntry, ConfigSettingEntry } from '@cortex-agent/ui-contract';
import {
  indexEnv,
  envRow,
  hasAnyKey,
  indexSettings,
  getSetting,
  ENV_MASK,
  SLACK_KEYS,
  FEISHU_KEYS,
} from './platform-env';

const env: ConfigEnvEntry[] = [
  { key: 'SLACK_BOT_TOKEN', present: true, masked: ENV_MASK },
  { key: 'SLACK_ADMIN_CHANNEL', present: true, masked: ENV_MASK },
  { key: 'ANTHROPIC_API_KEY', present: true, masked: ENV_MASK },
  { key: 'ANTHROPIC_BASE_URL', present: false, masked: '' },
  { key: 'CORTEX_MACHINE', present: true, masked: ENV_MASK },
];

describe('platform-env', () => {
  it('indexes env entries by key', () => {
    const idx = indexEnv(env);
    expect(idx['SLACK_BOT_TOKEN']?.present).toBe(true);
    expect(idx['ANTHROPIC_BASE_URL']?.present).toBe(false);
    expect(idx['NOPE']).toBeUndefined();
  });

  it('envRow: present → mask + ✓ present; absent-from-file → not present; missing key → dash', () => {
    const idx = indexEnv(env);
    expect(envRow(idx, 'SLACK_BOT_TOKEN')).toEqual({ key: 'SLACK_BOT_TOKEN', present: true, display: ENV_MASK });
    // key line exists in .env but value empty → present:false → em dash
    expect(envRow(idx, 'ANTHROPIC_BASE_URL')).toEqual({ key: 'ANTHROPIC_BASE_URL', present: false, display: '—' });
    // key not in .env at all → also treated as absent (honest: not set)
    expect(envRow(idx, 'WEBHOOK_PORT')).toEqual({ key: 'WEBHOOK_PORT', present: false, display: '—' });
  });

  it('never exposes a cleartext value — display is only the fixed mask or a dash', () => {
    const idx = indexEnv(env);
    for (const k of ['SLACK_BOT_TOKEN', 'CORTEX_MACHINE', 'ANTHROPIC_API_KEY']) {
      expect(envRow(idx, k).display).toBe(ENV_MASK);
    }
  });

  it('hasAnyKey detects whether any present key matches a prefix (platform presence)', () => {
    expect(hasAnyKey(env, 'SLACK_')).toBe(true);
    expect(hasAnyKey(env, 'FEISHU_')).toBe(false);
    // ANTHROPIC_BASE_URL is not present → but ANTHROPIC_API_KEY is
    expect(hasAnyKey(env, 'ANTHROPIC_')).toBe(true);
  });

  it('indexes effective settings values and provenance without consulting env presence', () => {
    const settings: ConfigSettingEntry[] = [
      { key: 'turnNotify', value: false, source: 'file' },
      { key: 'eventLog', value: true, source: 'default' },
      { key: 'adminChannel', value: 'C0123', source: 'env' },
      { key: 'taskDispatchMaxConcurrent', value: null, source: 'default' },
    ];
    const idx = indexSettings(settings);

    expect(getSetting(idx, 'turnNotify')).toEqual(settings[0]);
    expect(getSetting(idx, 'eventLog')).toEqual(settings[1]);
    expect(getSetting(idx, 'adminChannel')).toEqual(settings[2]);
    expect(getSetting(idx, 'taskDispatchMaxConcurrent')).toEqual(settings[3]);
    expect(getSetting(idx, 'notifyCompaction')).toBeUndefined();
  });

  it('does not list migrated admin channels as .env credential rows', () => {
    expect(SLACK_KEYS).not.toContain('SLACK_ADMIN_CHANNEL');
    expect(FEISHU_KEYS).not.toContain('FEISHU_ADMIN_CHANNEL');
  });
});
