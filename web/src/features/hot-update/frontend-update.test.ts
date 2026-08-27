// input:  staged update payloads and representative bundle byte sizes
// output: parsing and preserved update-size label regressions
// pos:    Unit tests for the native hot-update bridge
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { formatUpdateSize, parseStagedUpdate } from './frontend-update';

describe('formatUpdateSize', () => {
  it('preserves omitted, byte, rounded-KB, and fixed-one-decimal MB labels', () => {
    expect(formatUpdateSize(undefined)).toBeNull();
    expect(formatUpdateSize(0)).toBeNull();
    expect(formatUpdateSize(900)).toBe('900 B');
    expect(formatUpdateSize(1536)).toBe('2 KB');
    expect(formatUpdateSize(8.4 * 1024 * 1024)).toBe('8.4 MB');
    expect(formatUpdateSize(1024 ** 3)).toBe('1024.0 MB');
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
