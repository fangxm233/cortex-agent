import { describe, expect, it } from 'vitest';
import {
  AUTO_DISMISS_MS,
  PREVIEW_MAX,
  buildNotification,
  isTransient,
  previewText,
} from './notification-vm';

describe('previewText', () => {
  it('collapses internal whitespace/newlines to single spaces and trims', () => {
    expect(previewText('  hello\n\n  world\t!  ')).toBe('hello world !');
  });

  it('returns the text unchanged when within the limit', () => {
    expect(previewText('short reply')).toBe('short reply');
  });

  it('clips to PREVIEW_MAX with a trailing ellipsis', () => {
    const long = 'x'.repeat(PREVIEW_MAX + 40);
    const out = previewText(long);
    expect(out.length).toBe(PREVIEW_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles empty/nullish text safely', () => {
    expect(previewText('')).toBe('');
    expect(previewText(undefined as unknown as string)).toBe('');
  });
});

describe('buildNotification', () => {
  it('maps a session message to an info notification with a preview meta', () => {
    const n = buildNotification({
      id: 'n1',
      sessionId: 'sess-1',
      sessionName: 'cortex-3f2a',
      projectId: 'flywheel',
      text: 'Sure — I updated the config and re-ran the sweep.',
      ts: '2026-07-14T10:00:00.000Z',
    });
    expect(n).toEqual({
      id: 'n1',
      level: 'info',
      title: 'cortex-3f2a',
      meta: 'Sure — I updated the config and re-ran the sweep.',
      ts: '2026-07-14T10:00:00.000Z',
      sessionId: 'sess-1',
      projectId: 'flywheel',
    });
  });

  it('falls back to a generic title when the session has no name', () => {
    expect(buildNotification({ id: 'n', sessionId: 's', sessionName: null, projectId: null, text: 'hi' }).title).toBe('New message');
    expect(buildNotification({ id: 'n', sessionId: 's', sessionName: '   ', projectId: null, text: 'hi' }).title).toBe('New message');
  });

  it('defaults level to info and stamps a ts when omitted', () => {
    const n = buildNotification({ id: 'n', sessionId: 's', sessionName: 'x', projectId: null, text: 'hi' });
    expect(n.level).toBe('info');
    expect(typeof n.ts).toBe('string');
    expect(Number.isNaN(Date.parse(n.ts))).toBe(false);
  });

  it('honors an explicit level (future server-classified notifications)', () => {
    expect(buildNotification({ id: 'n', sessionId: 's', sessionName: 'x', projectId: null, text: 'boom', level: 'error' }).level).toBe('error');
  });
});

describe('isTransient / AUTO_DISMISS_MS', () => {
  it('info auto-dismisses; warning and error stay resident', () => {
    expect(isTransient('info')).toBe(true);
    expect(isTransient('warning')).toBe(false);
    expect(isTransient('error')).toBe(false);
  });

  it('auto-dismiss is 6s per scheme 18a', () => {
    expect(AUTO_DISMISS_MS).toBe(6000);
  });
});
