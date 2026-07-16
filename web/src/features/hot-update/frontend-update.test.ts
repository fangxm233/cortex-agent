import { describe, expect, it } from 'vitest';
import {
  formatUpdateSize,
  parseStagedUpdate,
  shortVersion,
  updateSummaryLine,
  versionTransitionLabel,
  type StagedUpdate,
} from './frontend-update';

describe('shortVersion', () => {
  it('takes the first 8 chars of a content hash', () => {
    expect(shortVersion('a3f9c21b7e2d90c1')).toBe('a3f9c21b');
  });
  it('leaves a short string untouched', () => {
    expect(shortVersion('abc')).toBe('abc');
  });
});

describe('versionTransitionLabel', () => {
  it('shows from → to when replacing a known version', () => {
    const u: StagedUpdate = { version: 'b7e2d90c1111', fromVersion: 'a3f9c21b2222' };
    expect(versionTransitionLabel(u)).toBe('a3f9c21b → b7e2d90c');
  });
  it('shows only the target when there is no prior version (first install)', () => {
    expect(versionTransitionLabel({ version: 'b7e2d90c1111' })).toBe('b7e2d90c');
  });
  it('collapses to a single id when from and to share the 8-char prefix', () => {
    expect(versionTransitionLabel({ version: 'b7e2d90cAAAA', fromVersion: 'b7e2d90cBBBB' })).toBe(
      'b7e2d90c',
    );
  });
});

describe('formatUpdateSize', () => {
  it('formats MB with one decimal', () => {
    expect(formatUpdateSize(8_808_038)).toBe('8.4 MB');
  });
  it('formats KB rounded', () => {
    expect(formatUpdateSize(2048)).toBe('2 KB');
  });
  it('formats small byte counts', () => {
    expect(formatUpdateSize(900)).toBe('900 B');
  });
  it('returns null for 0 / missing (segment omitted)', () => {
    expect(formatUpdateSize(0)).toBeNull();
    expect(formatUpdateSize(undefined)).toBeNull();
  });
});

describe('updateSummaryLine', () => {
  it('joins versions · size · 已下载', () => {
    const u: StagedUpdate = { version: 'b7e2d90c1111', fromVersion: 'a3f9c21b2222', size: 8_808_038 };
    expect(updateSummaryLine(u)).toBe('a3f9c21b → b7e2d90c · 8.4 MB · 已下载');
  });
  it('omits the size segment when size is unknown', () => {
    expect(updateSummaryLine({ version: 'b7e2d90c1111' })).toBe('b7e2d90c · 已下载');
  });
});

describe('parseStagedUpdate', () => {
  it('parses a well-formed payload', () => {
    expect(parseStagedUpdate({ version: 'b7e2', fromVersion: 'a3f9', size: 123 })).toEqual({
      version: 'b7e2',
      fromVersion: 'a3f9',
      size: 123,
    });
  });
  it('drops an empty fromVersion and non-number size', () => {
    expect(parseStagedUpdate({ version: 'b7e2', fromVersion: '', size: null })).toEqual({
      version: 'b7e2',
      fromVersion: undefined,
      size: undefined,
    });
  });
  it('rejects payloads without a version', () => {
    expect(parseStagedUpdate({ size: 1 })).toBeNull();
    expect(parseStagedUpdate(null)).toBeNull();
    expect(parseStagedUpdate('nope')).toBeNull();
  });
});
