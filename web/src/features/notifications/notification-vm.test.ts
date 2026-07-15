import { describe, expect, it } from 'vitest';
import {
  AUTO_DISMISS_MS,
  PREVIEW_MAX,
  buildNotification,
  buildSystemNotice,
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

describe('buildSystemNotice', () => {
  it('maps a system.notice event to a toast, defaulting to info', () => {
    const item = buildSystemNotice({ id: 's1', text: 'Cortex restarted' });
    expect(item.id).toBe('s1');
    expect(item.level).toBe('info');
    expect(item.title).toBe('System notice');
    expect(item.meta).toBe('Cortex restarted');
    // System notices are not tied to a conversation — no click-through target.
    expect(item.sessionId).toBe('');
    expect(item.projectId).toBeNull();
  });

  it('carries an explicit level and title', () => {
    const item = buildSystemNotice({ id: 's2', text: 'Disk low', level: 'warning', title: 'Disk' });
    expect(item.level).toBe('warning');
    expect(item.title).toBe('Disk');
  });

  it('clips a long body to the mono preview', () => {
    const long = 'x'.repeat(200);
    const item = buildSystemNotice({ id: 's3', text: long });
    expect(item.meta).toBe(previewText(long));
  });

  it('falls back to the generic title when title is blank', () => {
    const item = buildSystemNotice({ id: 's4', text: 'hi', title: '   ' });
    expect(item.title).toBe('System notice');
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
