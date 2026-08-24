// input:  html-sandbox pure functions
// output: regressions pinning the view isolation boundary
// pos:    guards the only defence an agent-rendered view has
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import {
  VIEW_SANDBOX,
  VIEW_HEIGHT_MIN,
  VIEW_HEIGHT_MAX,
  buildViewCsp,
  parseViewMessage,
  wrapViewDocument,
} from './html-sandbox';

// These four are the security contract, not style preferences. A failure here means a caller made
// an agent-authored document same-origin with the app — in the desktop shell that hands it the
// auth token and Tauri IPC. Fix the caller.
describe('sandbox token set', () => {
  it('is exactly allow-scripts', () => {
    expect(VIEW_SANDBOX).toBe('allow-scripts');
  });

  it('never grants allow-same-origin', () => {
    expect(VIEW_SANDBOX).not.toMatch(/allow-same-origin/);
  });

  it('never grants navigation, popups, forms, modals or downloads', () => {
    for (const forbidden of [
      'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-popups',
      'allow-popups-to-escape-sandbox', 'allow-forms', 'allow-modals', 'allow-downloads',
      'allow-pointer-lock', 'allow-presentation',
    ]) {
      expect(VIEW_SANDBOX).not.toMatch(forbidden);
    }
  });
});

describe('buildViewCsp', () => {
  it('denies everything by default and blocks form posts and base rewriting', () => {
    const csp = buildViewCsp(true);
    expect(csp).toMatch("default-src 'none'");
    expect(csp).toMatch("form-action 'none'");
    expect(csp).toMatch("base-uri 'none'");
  });

  it('allows https sources when the network is permitted', () => {
    const csp = buildViewCsp(true);
    expect(csp).toMatch(/script-src [^;]*https:/);
    expect(csp).toMatch(/connect-src[^;]*https:/);
  });

  it('produces a fully offline policy when the network is denied', () => {
    const csp = buildViewCsp(false);
    expect(csp).not.toMatch('https:');
    expect(csp).toMatch("connect-src 'none'");
  });
});

describe('wrapViewDocument', () => {
  it('wraps a bare fragment into a document with the injected head block', () => {
    const out = wrapViewDocument('<p>hi</p>');
    expect(out).toMatch(/^<!DOCTYPE html><html><head>/);
    expect(out).toMatch('<p>hi</p>');
    expect(out).toMatch('Content-Security-Policy');
    expect(out).toMatch('__cortexView');
  });

  it('splices into an existing head without restructuring the document', () => {
    const src = '<!DOCTYPE html><html><head><title>T</title></head><body><b>x</b></body></html>';
    const out = wrapViewDocument(src);
    expect(out).toMatch('<title>T</title>');
    expect(out).toMatch('<b>x</b>');
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
    expect(out.match(/<html[\s>]/gi)).toHaveLength(1);
  });

  it('opens a head for an <html> document that lacks one', () => {
    const out = wrapViewDocument('<html><body>x</body></html>');
    expect(out).toMatch('<head>');
    expect(out).toMatch('Content-Security-Policy');
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('<body>'));
  });

  it("keeps an author's own CSP instead of layering a second one", () => {
    const src = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body/></html>';
    const out = wrapViewDocument(src);
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(1);
  });

  it('injects the author-overridable base style before any author style', () => {
    const src = '<html><head><style>body{color:red}</style></head><body/></html>';
    const out = wrapViewDocument(src, { theme: 'dark' });
    expect(out).toMatch('color-scheme:dark');
    expect(out.indexOf('color-scheme:dark')).toBeLessThan(out.indexOf('body{color:red}'));
  });

  // The frame is a separate document, so the app's CSS variables cannot cascade in; the caller
  // resolves `--proto-ink` and passes the value. With no value the UA default for the declared
  // color-scheme applies, which is already correct in both themes.
  it('carries the resolved ink colour across, and omits it when absent', () => {
    expect(wrapViewDocument('<p/>', { ink: 'rgb(20, 20, 20)' })).toMatch('color:rgb(20, 20, 20);');
    expect(wrapViewDocument('<p/>')).not.toMatch(/html,body\{[^}]*color:/);
  });

  it('never lets a token value escape its declaration', () => {
    const out = wrapViewDocument('<p/>', { ink: 'red}body{display:none' });
    expect(out).not.toMatch('display:none');
  });

  it('never throws on junk input', () => {
    expect(() => wrapViewDocument('')).not.toThrow();
    expect(() => wrapViewDocument('<html <<< unclosed')).not.toThrow();
    expect(() => wrapViewDocument(undefined as unknown as string)).not.toThrow();
  });
});

describe('parseViewMessage', () => {
  it('accepts a height message and clamps it', () => {
    expect(parseViewMessage({ __cortexView: 'height', value: 420 })).toEqual({ type: 'height', value: 420 });
    expect(parseViewMessage({ __cortexView: 'height', value: 1 })).toEqual({ type: 'height', value: VIEW_HEIGHT_MIN });
    expect(parseViewMessage({ __cortexView: 'height', value: 1e9 })).toEqual({ type: 'height', value: VIEW_HEIGHT_MAX });
    expect(parseViewMessage({ __cortexView: 'height', value: 5000 }, 20000)).toEqual({ type: 'height', value: 5000 });
  });

  it('reserves submit so the protocol does not change when it ships', () => {
    expect(parseViewMessage({ __cortexView: 'submit', value: { a: 1 } })).toEqual({ type: 'submit', value: { a: 1 } });
  });

  it('ignores foreign and malformed messages', () => {
    expect(parseViewMessage(null)).toBeNull();
    expect(parseViewMessage('height')).toBeNull();
    expect(parseViewMessage({ type: 'height', value: 300 })).toBeNull();
    expect(parseViewMessage({ __cortexView: 'height', value: 'tall' })).toBeNull();
    expect(parseViewMessage({ __cortexView: 'unknown' })).toBeNull();
  });
});
