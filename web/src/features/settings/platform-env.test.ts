import { describe, it, expect } from 'vitest';
import type { ConfigEnvEntry } from '@cortex-agent/ui-contract';
import { indexEnv, envRow, hasAnyKey, ENV_MASK } from './platform-env';

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
});
