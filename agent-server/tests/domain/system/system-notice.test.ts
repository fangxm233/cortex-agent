// input:  node:test, src/domain/system/system-notice
// output: Test results for publishSystemNotice + emitSystemNotice
// pos:    Verifies the encapsulated system-notice seam: the bus `system.notice` event
//         (default/explicit level, no-op without a bus) and the combined post+publish
//         path (platform admin post AND bus event, event fires even if the post fails).
// >>> If I am updated, update the parent folder's CORTEX.md <<<

import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';

import { ctx as jobCtx } from '../../../src/domain/scheduling/job-registry.js';
import { MockAdapter } from '../../../src/platform/testing.js';
import { publishSystemNotice, emitSystemNotice } from '../../../src/domain/system/system-notice.js';

function captureBus(): any[] {
  const events: any[] = [];
  jobCtx.bus = { publish: (e: any) => events.push(e), subscribe: () => ({ unsubscribe() {} }) } as any;
  return events;
}

afterEach(() => {
  jobCtx.bus = null;
  jobCtx.adapter = null;
});

describe('publishSystemNotice', () => {
  it('emits a system.notice event defaulting to info level', () => {
    const events = captureBus();
    publishSystemNotice({ text: 'server restarted' });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'system.notice');
    assert.equal(events[0].level, 'info');
    assert.equal(events[0].text, 'server restarted');
  });

  it('carries an explicit level and optional title', () => {
    const events = captureBus();
    publishSystemNotice({ text: 'disk low', level: 'warning', title: 'Disk' });
    assert.equal(events[0].level, 'warning');
    assert.equal(events[0].title, 'Disk');
  });

  it('is a no-op when no bus is wired', () => {
    jobCtx.bus = null;
    assert.doesNotThrow(() => publishSystemNotice({ text: 'x' }));
  });
});

describe('emitSystemNotice', () => {
  it('posts to the platform admin channel and publishes the event', async () => {
    const events = captureBus();
    const adapter = new MockAdapter({ adminChannel: 'mock-admin' });
    const ok = await emitSystemNotice(adapter, { text: 'hot reloaded', level: 'info' });
    assert.equal(ok, true);

    // platform post
    assert.equal(adapter.posted.length, 1);
    assert.equal(adapter.posted[0].destination.type, 'system-notice');
    assert.equal((adapter.posted[0].content as any).text, 'hot reloaded');

    // bus event
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'system.notice');
    assert.equal(events[0].text, 'hot reloaded');
  });

  it('still publishes the event when the platform post fails', async () => {
    const events = captureBus();
    const adapter = new MockAdapter();
    adapter.failPostMessageCount = 1;
    const ok = await emitSystemNotice(adapter, { text: 'boom' });
    assert.equal(ok, false);
    assert.equal(events.length, 1); // web toast fires regardless of admin-channel delivery
  });
});
