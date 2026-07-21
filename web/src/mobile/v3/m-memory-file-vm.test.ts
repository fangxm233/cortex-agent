import { describe, it, expect } from 'vitest';
import { fileBasename, formatBytes, fileMetaLine } from './m-memory-file-vm';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

describe('fileBasename', () => {
  it('returns the last path segment', () => {
    expect(fileBasename('experiments/EXP-001.md')).toBe('EXP-001.md');
    expect(fileBasename('STATUS.md')).toBe('STATUS.md');
  });
  it('tolerates trailing/leading slashes and empty input', () => {
    expect(fileBasename('a/b/c.md/')).toBe('c.md');
    expect(fileBasename('')).toBe('');
  });
});

describe('formatBytes', () => {
  it('formats bytes / KB / MB with a trimmed decimal', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB');
  });
  it('returns "" for unknown/invalid sizes (never fabricated)', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(NaN)).toBe('');
  });
});

describe('fileMetaLine', () => {
  it('joins path · rel-time · size', () => {
    expect(
      fileMetaLine(
        { path: 'experiments/EXP-001.md', modifiedAt: new Date(NOW - 30 * 60_000).toISOString(), sizeBytes: 1536 },
        NOW,
      ),
    ).toBe('experiments/EXP-001.md · 30 分钟 · 1.5 KB');
  });
  it('drops empty segments (no time / no size → path only, never fabricated)', () => {
    expect(fileMetaLine({ path: 'STATUS.md', modifiedAt: null, sizeBytes: null }, NOW)).toBe('STATUS.md');
    expect(fileMetaLine({ path: 'STATUS.md', modifiedAt: 'not-a-date', sizeBytes: 0 }, NOW)).toBe('STATUS.md · 0 B');
  });
  it('returns "" for a null file', () => {
    expect(fileMetaLine(null, NOW)).toBe('');
  });
});
