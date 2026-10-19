import { describe, expect, it } from 'vitest';
import { en } from '@/i18n';
import type { AgentBrowserSession } from './agent-browser-api';
import { streamSocketUrl } from './agent-browser-api';
import { capsuleSummary } from './AgentBrowserCapsule';
import {
  INITIAL_STREAM,
  bodyStatus,
  fitRect,
  keyMessage,
  modifiersOf,
  pageHost,
  parseStreamMessage,
  pollIntervalMs,
  retryDelayMs,
  routeKey,
  streamReducer,
  toPagePoint,
  wheelPixels,
  type KeyLike,
} from './stream-model';

const key = (over: Partial<KeyLike>): KeyLike => ({
  key: 'a', code: 'KeyA', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over,
});

const session = (over: Partial<AgentBrowserSession> = {}): AgentBrowserSession => ({
  sessionId: 's1', device: 'my-pc', state: 'ready', takenOver: false, lastUsedAt: 1, ...over,
});

describe('geometry', () => {
  it('letterboxes a wide page in a tall box, centred', () => {
    expect(fitRect(640, 720, 1280, 720)).toEqual({ x: 0, y: 180, width: 640, height: 360 });
    expect(fitRect(0, 100, 1280, 720)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('maps through the page size, not the frame pixels', () => {
    const fit = fitRect(640, 720, 1280, 720);
    // A frame capped at 640px wide still describes a 1280×720 page.
    const meta = { deviceWidth: 1280, deviceHeight: 720 };
    expect(toPagePoint(320, 360, fit, meta)).toEqual({ x: 640, y: 360 });
    expect(toPagePoint(0, 180, fit, meta)).toEqual({ x: 0, y: 0 });
    expect(toPagePoint(640, 540, fit, meta)).toEqual({ x: 1280, y: 720 });
  });

  it('ignores a point on the letterbox', () => {
    const fit = fitRect(640, 720, 1280, 720);
    expect(toPagePoint(320, 100, fit, { deviceWidth: 1280, deviceHeight: 720 })).toBeNull();
  });
});

describe('keys', () => {
  it('keeps app shortcuts with the app, and hands ⌘/Ctrl+V to the paste event', () => {
    expect(routeKey(key({ key: 'k', metaKey: true }))).toBe('app');
    expect(routeKey(key({ key: 'j', ctrlKey: true }))).toBe('app');
    expect(routeKey(key({ key: 'v', metaKey: true }))).toBe('paste');
    expect(routeKey(key({ key: 'F11', code: 'F11' }))).toBe('app');
  });

  it('sends plain keys, editing keys and select-all / undo to the page', () => {
    expect(routeKey(key({ key: 'x' }))).toBe('page');
    expect(routeKey(key({ key: 'Backspace', code: 'Backspace' }))).toBe('page');
    expect(routeKey(key({ key: 'a', ctrlKey: true }))).toBe('page');
    expect(routeKey(key({ key: 'z', metaKey: true }))).toBe('page');
  });

  it('leaves composition to the IME', () => {
    expect(routeKey(key({ key: 'Process' }))).toBe('app');
    expect(routeKey(key({ key: 'n', isComposing: true }))).toBe('app');
  });

  it('carries text for printable keys and the virtual-key code for editing keys', () => {
    expect(keyMessage(key({ key: 'Q', code: 'KeyQ', shiftKey: true, keyCode: 81 }), 'keyDown')).toEqual({
      type: 'input_keyboard', eventType: 'keyDown', key: 'Q', code: 'KeyQ', modifiers: 8, windowsVirtualKeyCode: 81, text: 'Q',
    });
    expect(keyMessage(key({ key: 'Backspace', code: 'Backspace', keyCode: 8 }), 'keyDown')).toEqual({
      type: 'input_keyboard', eventType: 'keyDown', key: 'Backspace', code: 'Backspace', modifiers: 0, windowsVirtualKeyCode: 8,
    });
    expect(keyMessage(key({ key: 'Enter', code: 'Enter', keyCode: 13 }), 'keyDown').text).toBe('\r');
    expect(keyMessage(key({ key: 'a', ctrlKey: true, keyCode: 65 }), 'keyDown').text).toBeUndefined();
    expect(keyMessage(key({ key: 'a' }), 'keyUp').text).toBeUndefined();
  });

  it('maps ⌘ onto Ctrl for the remote page', () => {
    expect(modifiersOf({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true })).toBe(1 | 2 | 8);
  });

  it('converts wheel lines and pages to pixels', () => {
    expect(wheelPixels(3, 1)).toBe(48);
    expect(wheelPixels(-120, 0)).toBe(-120);
  });
});

describe('stream state', () => {
  it('goes live on the first frame and keeps url/title from the stream', () => {
    let s = streamReducer(INITIAL_STREAM, { type: 'connect' });
    s = streamReducer(s, { type: 'open' });
    expect(bodyStatus(session(), s)).toBe('connecting');
    s = streamReducer(s, { type: 'frame', meta: { deviceWidth: 1280, deviceHeight: 720 } });
    expect(bodyStatus(session(), s)).toBe('live');
    s = streamReducer(s, { type: 'tabs', tabs: [{ active: false, title: 'Other' }, { active: true, title: 'Example', url: 'https://example.com/' }] });
    expect([s.title, s.url]).toEqual(['Example', 'https://example.com/']);
    s = streamReducer(s, { type: 'url', url: 'https://example.com/b' });
    expect(s.url).toBe('https://example.com/b');
  });

  it('counts drops until a frame arrives', () => {
    let s = streamReducer(INITIAL_STREAM, { type: 'drop' });
    s = streamReducer(s, { type: 'drop' });
    expect(s.failures).toBe(2);
    expect(bodyStatus(session(), s)).toBe('retrying');
    s = streamReducer(s, { type: 'frame', meta: { deviceWidth: 1, deviceHeight: 1 } });
    expect(s.failures).toBe(0);
  });

  it('puts the lease state ahead of the stream', () => {
    const live = streamReducer(INITIAL_STREAM, { type: 'frame', meta: { deviceWidth: 1, deviceHeight: 1 } });
    expect(bodyStatus(null, live)).toBe('none');
    expect(bodyStatus(session({ state: 'starting' }), live)).toBe('starting');
    expect(bodyStatus(session({ state: 'error' }), live)).toBe('error');
  });

  it('backs off to 8 s', () => {
    expect([1, 2, 3, 4, 9].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 8000]);
  });

  it('parses only what the view uses', () => {
    expect(parseStreamMessage('{"type":"frame","seq":3,"data":"QQ==","metadata":{"deviceWidth":10,"deviceHeight":5}}'))
      .toEqual({ type: 'frame', seq: 3, data: 'QQ==', meta: { deviceWidth: 10, deviceHeight: 5 } });
    expect(parseStreamMessage('{"type":"frame","seq":3,"data":"QQ==","metadata":{}}')).toBeNull();
    expect(parseStreamMessage('{"type":"status","connected":true}')).toBeNull();
    expect(parseStreamMessage('garbage')).toBeNull();
  });
});

describe('polling', () => {
  it('polls only while something can change', () => {
    expect(pollIntervalMs({ visible: true, running: false, hasLease: false, viewing: false })).toBe(false);
    expect(pollIntervalMs({ visible: true, running: true, hasLease: false, viewing: false })).toBe(3000);
    expect(pollIntervalMs({ visible: true, running: false, hasLease: true, viewing: false })).toBe(10_000);
    expect(pollIntervalMs({ visible: true, running: false, hasLease: true, viewing: true })).toBe(2000);
    expect(pollIntervalMs({ visible: false, running: true, hasLease: true, viewing: true })).toBe(false);
  });
});

describe('labels', () => {
  it('names the host, or nothing for a blank page', () => {
    expect(pageHost('https://example.com:8443/a?b')).toBe('example.com:8443');
    expect(pageHost('about:blank')).toBeNull();
    expect(pageHost(undefined)).toBeNull();
  });

  it('summarises the capsule by state', () => {
    expect(capsuleSummary(session({ state: 'starting' }), en)).toEqual({ parts: ['Browser', 'my-pc', 'Starting…'], tone: 'busy' });
    expect(capsuleSummary(session({ state: 'error' }), en).tone).toBe('bad');
    expect(capsuleSummary(session({ takenOver: true }), en).parts[2]).toBe('You are in control');
    expect(capsuleSummary(session({ device: 'server', url: 'https://example.com/x' }), en).parts).toEqual(['Browser', 'server', 'example.com']);
  });
});

describe('stream socket url', () => {
  it('follows the configured server in a native shell', () => {
    expect(streamSocketUrl('s 1', 'tk', 10, 'https://cortex.example.com/')).toBe(
      'wss://cortex.example.com/api/browser/stream?session=s+1&ticket=tk&maxFps=10');
  });

  it('follows the page origin in a browser', () => {
    expect(streamSocketUrl('s1', 'tk', 10, '', 'http://localhost:5174/workbench')).toBe(
      'ws://localhost:5174/api/browser/stream?session=s1&ticket=tk&maxFps=10');
  });
});
