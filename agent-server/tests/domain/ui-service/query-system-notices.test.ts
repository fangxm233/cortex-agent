import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSystemNotices } from '../../../src/domain/ui-service/query/system.js';
import {
  recordSystemNotice,
  resetSystemNoticeHistory,
  NOTICE_HISTORY_CAP,
} from '../../../src/domain/system/notice-history.js';

afterEach(() => {
  resetSystemNoticeHistory();
});

test('system.notices returns the ring buffer newest first with its cap', async () => {
  recordSystemNotice({ text: 'first' });
  recordSystemNotice({ text: 'second', level: 'warning', title: 'Disk' });

  const result = await handleSystemNotices({});
  assert.equal(result.cap, NOTICE_HISTORY_CAP);
  assert.deepEqual(result.entries.map((e) => e.text), ['second', 'first']);
  assert.equal(result.entries[0].level, 'warning');
  assert.equal(result.entries[0].title, 'Disk');
});
