import { afterEach, describe, expect, it } from 'vitest';
import {
  allowClientKindHeader, clientKind, clientKindHeaders, resetClientKindHeaderForTest,
} from './client-kind';

type ShellGlobal = typeof globalThis & { __CORTEX_DESKTOP__?: boolean; __CORTEX_MOBILE__?: boolean };
const shell = globalThis as ShellGlobal;

afterEach(() => {
  delete shell.__CORTEX_DESKTOP__;
  delete shell.__CORTEX_MOBILE__;
  resetClientKindHeaderForTest();
});

describe('client kind header', () => {
  it('names the shell the page runs in', () => {
    expect(clientKind()).toBe('browser');
    shell.__CORTEX_DESKTOP__ = true;
    expect(clientKind()).toBe('desktop');
    shell.__CORTEX_MOBILE__ = true;
    expect(clientKind()).toBe('android');
  });

  it('is always sent by the same-origin browser', () => {
    expect(clientKindHeaders()).toEqual({ 'x-cortex-client': 'browser' });
  });

  it('waits in native shells until the server is known to accept it', () => {
    shell.__CORTEX_MOBILE__ = true;
    expect(clientKindHeaders()).toEqual({});
    allowClientKindHeader();
    expect(clientKindHeaders()).toEqual({ 'x-cortex-client': 'android' });
  });
});
