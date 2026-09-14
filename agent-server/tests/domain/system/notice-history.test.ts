// input:  node:test, src/domain/system/notice-history
// output: Test results for recordSystemNotice + listSystemNotices ring buffer
// pos:    Verifies cap enforcement, newest-first ordering, limit clamping, and test reset.

import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';

import {
  recordSystemNotice,
  listSystemNotices,
  resetSystemNoticeHistory,
  NOTICE_HISTORY_CAP,
} from '../../../src/domain/system/notice-history.js';

afterEach(() => {
  resetSystemNoticeHistory();
});

describe('notice-history', () => {
  it('returns entries newest first', () => {
    recordSystemNotice({ text: 'first' });
    recordSystemNotice({ text: 'second' });
    const entries = listSystemNotices();
    assert.deepEqual(entries.map((e) => e.text), ['second', 'first']);
  });

  it('defaults level to info and carries an optional title', () => {
    recordSystemNotice({ text: 'disk low', level: 'warning', title: 'Disk' });
    recordSystemNotice({ text: 'plain' });
    const [plain, warn] = listSystemNotices();
    assert.equal(warn.level, 'warning');
    assert.equal(warn.title, 'Disk');
    assert.equal(plain.level, 'info');
    assert.equal(plain.title, undefined);
  });

  it('assigns monotonically increasing ids and ISO timestamps', () => {
    recordSystemNotice({ text: 'a' });
    recordSystemNotice({ text: 'b' });
    const [b, a] = listSystemNotices();
    assert.notEqual(a.id, b.id);
    assert.doesNotThrow(() => new Date(a.ts).toISOString());
  });

  it('caps the history at NOTICE_HISTORY_CAP entries, dropping the oldest', () => {
    for (let i = 0; i < NOTICE_HISTORY_CAP + 10; i++) {
      recordSystemNotice({ text: `n${i}` });
    }
    const entries = listSystemNotices();
    assert.equal(entries.length, NOTICE_HISTORY_CAP);
    assert.equal(entries[0].text, `n${NOTICE_HISTORY_CAP + 9}`);
    assert.equal(entries[entries.length - 1].text, `n10`);
  });

  it('clamps to the given limit', () => {
    for (let i = 0; i < 5; i++) recordSystemNotice({ text: `n${i}` });
    assert.equal(listSystemNotices(2).length, 2);
    assert.deepEqual(listSystemNotices(2).map((e) => e.text), ['n4', 'n3']);
  });

  it('resetSystemNoticeHistory clears entries', () => {
    recordSystemNotice({ text: 'x' });
    resetSystemNoticeHistory();
    assert.deepEqual(listSystemNotices(), []);
  });
});
