import { describe, expect, it } from 'vitest';
import { nativeErrorMessage, nativeErrorText, parseNativeError } from './native-error';

describe('native error codes', () => {
  it('splits a code from its detail', () => {
    expect(parseNativeError('no_update_prepared')).toEqual({ code: 'no_update_prepared', detail: null });
    expect(parseNativeError('command_failed: hdiutil exited with 1')).toEqual({ code: 'command_failed', detail: 'hdiutil exited with 1' });
    expect(parseNativeError('UI_ENABLE_FAILED: line 1\nline 2')).toEqual({ code: 'UI_ENABLE_FAILED', detail: 'line 1\nline 2' });
    expect(parseNativeError('Failed to fetch')).toBeNull();
  });

  it('words known codes, appends detail, and passes everything else through raw', () => {
    const copy = { no_update_prepared: 'Nothing to install', command_failed: 'A system tool failed' };
    expect(nativeErrorText('no_update_prepared', copy)).toBe('Nothing to install');
    expect(nativeErrorText(new Error('command_failed: ditto exited with 2'), copy)).toBe('A system tool failed (ditto exited with 2)');
    expect(nativeErrorText('other_code: x', copy)).toBe('other_code: x');
    expect(nativeErrorText('toString', copy)).toBe('toString');
    expect(nativeErrorText('free-form message', copy)).toBe('free-form message');
  });

  it('reads string rejections as well as Error objects', () => {
    expect(nativeErrorMessage('raw')).toBe('raw');
    expect(nativeErrorMessage(new Error('boom'))).toBe('boom');
    expect(nativeErrorMessage(42)).toBe('42');
  });
});
