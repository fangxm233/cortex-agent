import { describe, expect, it } from 'vitest';
import { parseStagedUpdate } from './frontend-update';

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
