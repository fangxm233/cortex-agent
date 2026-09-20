// input:  malformed tap payloads and authoritative server targets
// output: encoded routing, deletion and lookup failure tests
// pos:    Mobile notification target validation regressions
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import { describe, expect, it, vi } from 'vitest';
import { notificationTargetId, resolveNotificationRoute, sessionPathId } from './m-notification-routing';

const lookups = () => ({
  sessions: vi.fn(async () => [{ sessionId: 'session/with?#', projectId: 'actual-project' }]),
  approvals: vi.fn(async () => [{ id: 'approval/with?#', projectId: 'other-project' }]),
});

describe('mobile notification target validation', () => {
  it('reads back only the session a mobile route actually shows', () => {
    expect(sessionPathId(`/m/session/${encodeURIComponent('session/with?#')}`)).toBe('session/with?#');
    ['/m/sessions', '/m/session/', '/m/session/one/detail', '/m/project', '/m/session/%E0%A4%A'].forEach((path) => {
      expect(sessionPathId(path)).toBeNull();
    });
  });

  it.each([undefined, null, {}, [], '', ' ', 'a\n', '\ud800', 'x'.repeat(513)])('rejects invalid target %j', (value) => {
    expect(notificationTargetId(value)).toBeUndefined();
  });

  it('uses authoritative project scope and encodes path/query targets', async () => {
    const lookup = lookups();
    expect(await resolveNotificationRoute({ kind: 'session', sessionId: 'session/with?#', projectId: 'forged' }, lookup))
      .toEqual({ path: '/m/session/session%2Fwith%3F%23', projectId: 'actual-project' });
    expect(await resolveNotificationRoute({ kind: 'approvals', approvalId: 'approval/with?#' }, lookup))
      .toEqual({ path: '/m/approvals?approvalId=approval%2Fwith%3F%23', projectId: 'other-project' });
  });

  it('routes unknown and deleted targets to their safe lists', async () => {
    const lookup = lookups();
    expect(await resolveNotificationRoute({ kind: 'javascript:alert(1)' }, lookup)).toEqual({ path: '/m/sessions' });
    expect(await resolveNotificationRoute({ kind: 'approvals', approvalId: 'deleted' }, lookup)).toEqual({ path: '/m/approvals' });
    expect(await resolveNotificationRoute({ kind: 'session', sessionId: '\ud800' }, lookup)).toEqual({ path: '/m/sessions' });
    expect(lookup.sessions).not.toHaveBeenCalled();
  });

  it('propagates network failure so the retained action is not acknowledged', async () => {
    const lookup = lookups();
    lookup.sessions.mockRejectedValue(new Error('offline'));
    await expect(resolveNotificationRoute({ sessionId: 'session/with?#' }, lookup)).rejects.toThrow('offline');
  });
});
