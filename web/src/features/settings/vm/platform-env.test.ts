import { describe, it, expect } from 'vitest';
import type { ConfigEnvEntry } from '@cortex-agent/ui-contract';
import {
  indexEnv,
  parseWholeNumber,
  durationDraftFromMs,
  durationDraftToMs,
} from './platform-env';

const MASK = '••••••••';
const env: ConfigEnvEntry[] = [
  { key: 'SLACK_BOT_TOKEN', present: true, masked: MASK },
  { key: 'ANTHROPIC_BASE_URL', present: false, masked: '' },
];

describe('platform-env', () => {

  it('indexEnv: keys each entry by name; a missing key is undefined', () => {
    const idx = indexEnv(env);
    expect(idx.SLACK_BOT_TOKEN).toEqual({ key: 'SLACK_BOT_TOKEN', present: true, masked: MASK });
    expect(idx.ANTHROPIC_BASE_URL).toEqual({ key: 'ANTHROPIC_BASE_URL', present: false, masked: '' });
    expect(idx.WEBHOOK_PORT).toBeUndefined();
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
