// input:  untrusted iframe title messages, sources and origins
// output: parser and frame-routing regressions
// pos:    Unit tests for frame-title message validation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { FRAME_TITLE_TAG, matchFrameTitleMessage, parseFrameTitleMessage } from './frame-title';

describe('parseFrameTitleMessage', () => {
  it('normalizes a title from the same origin as its reported URL', () => {
    expect(parseFrameTitleMessage({
      type: FRAME_TITLE_TAG,
      title: '  Robot\n  Dashboard  ',
      href: 'http://127.0.0.1:41235/app',
      timeOrigin: 1000,
      phase: 'load',
    }, 'http://127.0.0.1:41235')).toEqual({
      title: 'Robot Dashboard',
      href: 'http://127.0.0.1:41235/app',
      timeOrigin: 1000,
      phase: 'load',
    });
  });

  it('uses null to clear an empty document title', () => {
    expect(parseFrameTitleMessage({
      type: FRAME_TITLE_TAG,
      title: '   ',
      href: 'https://example.com/',
      timeOrigin: 1000,
      phase: 'restore',
    }, 'https://example.com')).toEqual({
      title: null,
      href: 'https://example.com/',
      timeOrigin: 1000,
      phase: 'restore',
    });
  });

  it('bounds title text without changing its URL', () => {
    const parsed = parseFrameTitleMessage({
      type: FRAME_TITLE_TAG,
      title: 'x'.repeat(400),
      href: 'http://localhost:5173/',
      timeOrigin: 1000,
      phase: 'update',
    }, 'http://localhost:5173');
    expect(parsed?.title).toHaveLength(160);
    expect(parsed?.href).toBe('http://localhost:5173/');
  });

  it('rejects malformed, non-web and origin-mismatched messages', () => {
    const valid = { type: FRAME_TITLE_TAG, title: 'x', href: 'http://localhost:5173/', timeOrigin: 1000, phase: 'load' };
    expect(parseFrameTitleMessage({}, 'http://localhost:5173')).toBeNull();
    expect(parseFrameTitleMessage({ ...valid, title: 3 }, 'http://localhost:5173')).toBeNull();
    expect(parseFrameTitleMessage({ ...valid, href: 'file:///tmp/x' }, 'null')).toBeNull();
    expect(parseFrameTitleMessage(valid, 'http://localhost:3000')).toBeNull();
    expect(parseFrameTitleMessage({ ...valid, timeOrigin: undefined }, 'http://localhost:5173')).toBeNull();
    expect(parseFrameTitleMessage({ ...valid, phase: 'unknown' }, 'http://localhost:5173')).toBeNull();
  });
});

describe('matchFrameTitleMessage', () => {
  const data = {
    type: FRAME_TITLE_TAG,
    title: 'Dashboard',
    href: 'http://127.0.0.1:41235/',
    timeOrigin: 1000,
    phase: 'load',
  };
  const sourceA = {};
  const sourceB = {};
  const frames = new Map([
    ['tab-a', { contentWindow: sourceA }],
    ['tab-b', { contentWindow: sourceB }],
  ]);

  it('routes a valid message by frame identity', () => {
    expect(matchFrameTitleMessage(frames, sourceB, data, 'http://127.0.0.1:41235')).toEqual({
      tabId: 'tab-b',
      title: 'Dashboard',
      timeOrigin: 1000,
      phase: 'load',
    });
  });

  it('rejects a sibling source or invalid payload', () => {
    expect(matchFrameTitleMessage(frames, {}, data, 'http://127.0.0.1:41235')).toBeNull();
    expect(matchFrameTitleMessage(frames, sourceA, data, 'http://127.0.0.1:3000')).toBeNull();
  });
});
