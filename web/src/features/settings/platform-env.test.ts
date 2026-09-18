import { describe, it, expect } from 'vitest';
import type { ConfigEnvEntry } from '@cortex-agent/ui-contract';
import {
  indexEnv,
  envRow,
  ENV_MASK,
  parseWholeNumber,
  durationDraftFromMs,
  durationDraftToMs,
} from './platform-env';

const env: ConfigEnvEntry[] = [
  { key: 'SLACK_BOT_TOKEN', present: true, masked: ENV_MASK },
  { key: 'SLACK_ADMIN_CHANNEL', present: true, masked: ENV_MASK },
  { key: 'ANTHROPIC_API_KEY', present: true, masked: ENV_MASK },
  { key: 'ANTHROPIC_BASE_URL', present: false, masked: '' },
  { key: 'CORTEX_MACHINE', present: true, masked: ENV_MASK },
];

describe('platform-env', () => {

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

  it('parses only safe whole-number drafts', () => {
    expect(parseWholeNumber('0')).toBe(0);
    expect(parseWholeNumber('45')).toBe(45);
    expect(parseWholeNumber('1.5')).toBeNull();
    expect(parseWholeNumber('-1')).toBeNull();
    expect(parseWholeNumber('')).toBeNull();
    expect(parseWholeNumber(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });

  it('converts built-in job intervals using exact safe units and timer bounds', () => {
    expect(durationDraftFromMs(30_000)).toEqual({ value: 30, unit: 'sec' });
    expect(durationDraftFromMs(21_600_000)).toEqual({ value: 6, unit: 'hr' });
    expect(durationDraftToMs(2, 'min')).toBe(120_000);
    expect(durationDraftToMs(0.5, 'sec')).toBeNull();
    expect(durationDraftToMs(1, 'sec')).toBe(1_000);
    expect(durationDraftToMs(596.6, 'hr')).toBeNull();
  });
});
