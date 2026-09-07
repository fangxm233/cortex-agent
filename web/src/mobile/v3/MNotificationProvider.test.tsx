// input:  mocked feed, native actions, server targets and router
// output: scoped routing, visible suppression and cleanup tests
// pos:    Mobile notification adapter regression tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseNotificationFeedOptions } from '@/features/notifications/useNotificationFeed';
import type { NotificationItem } from '@/features/notifications/notification-vm';
import type { MNotificationToasterProps } from './MNotificationToaster';
import type { OsActionHandler } from '@/features/notifications/os-notify';

const h = vi.hoisted(() => ({
  pathname: '/m/project', feed: null as UseNotificationFeedOptions | null,
  toaster: null as MNotificationToasterProps | null, action: null as OsActionHandler | null,
  navigate: vi.fn(), project: vi.fn(), dismiss: vi.fn(), lifecycle: vi.fn(),
  send: vi.fn(async () => true), cleanup: vi.fn(), sessions: vi.fn(), approvals: vi.fn(),
  status: vi.fn(),
}));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: h.pathname }), useNavigate: () => h.navigate }));
vi.mock('@/i18n', () => ({ useLang: () => 'zh' }));
vi.mock('@/lib/native-bridge', () => ({ mobileNotificationStatus: h.status }));
vi.mock('@/lib/trpc', () => {
  const client = { sessions: { list: { query: h.sessions } }, approvals: { list: { query: h.approvals } } };
  return { useTRPCClient: () => client };
});
vi.mock('@/features/projects/CurrentProjectProvider', () => ({ useCurrentProject: () => ({ setCurrentProject: h.project }) }));
vi.mock('@/features/notifications/mobile-notifications', () => ({ useMobileNotificationLifecycle: h.lifecycle }));
vi.mock('@/features/notifications/useNotificationFeed', () => ({
  useNotificationFeed: (options: UseNotificationFeedOptions) => { h.feed = options; return { items: [], dismiss: h.dismiss }; },
}));
vi.mock('@/features/notifications/os-notify', () => ({
  sendOsNotification: h.send,
  osNotificationSpec: (item: NotificationItem) => ({ title: item.title, body: item.meta }),
  onOsNotificationAction: async (callback: OsActionHandler) => { h.action = callback; return h.cleanup; },
}));
vi.mock('./MNotificationToaster', () => ({ MNotificationToaster: (props: MNotificationToasterProps) => { h.toaster = props; return null; } }));
import { MNotificationProvider } from './MNotificationProvider';

function item(): NotificationItem {
  return { id: 'n1', level: 'info', title: 'Inbox', meta: 'Done', ts: '', sessionId: 's1', projectId: 'atlas' };
}
let mounted: ReactTestRenderer;
beforeEach(async () => {
  vi.clearAllMocks();
  h.pathname = '/m/project';
  h.status.mockResolvedValue({ scope: 'current' });
  h.sessions.mockResolvedValue([{ sessionId: 's1', projectId: 'atlas' }, { sessionId: 's/2?#', projectId: 'orion' }]);
  h.approvals.mockResolvedValue([{ id: 'apr/2?', projectId: 'other-project' }]);
  vi.stubGlobal('document', { visibilityState: 'visible' });
  await act(async () => { mounted = create(<MNotificationProvider />); });
});
afterEach(() => { act(() => mounted.unmount()); vi.unstubAllGlobals(); });

describe('mobile notification delivery', () => {
  it('reconciles native lifecycle and suppresses only visible active sessions', async () => {
    expect(h.lifecycle).toHaveBeenCalledWith('zh');
    expect(h.feed?.isSessionOpen('s1')).toBe(false);
    const pendingDeliveryPredicate = h.feed?.isSessionOpen;
    h.pathname = '/m/session/s1';
    act(() => mounted.update(<MNotificationProvider />));
    expect(h.feed?.isSessionOpen('s1')).toBe(true);
    expect(pendingDeliveryPredicate?.('s1')).toBe(true);
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    expect(h.feed?.isSessionOpen('s1')).toBe(false);
    await expect(h.feed?.externalDelivery?.(item())).resolves.toBe(true);
    expect(h.send).toHaveBeenCalledWith({ title: 'Inbox', body: 'Done' }, { kind: 'session', sessionId: 's1', projectId: 'atlas' });
  });

  it('sets authoritative project before an encoded session route for warm/cold callbacks', async () => {
    await act(async () => { await h.action?.({ kind: 'session', sessionId: 's/2?#', projectId: 'wrong', scope: 'current' }); });
    expect(h.project).toHaveBeenCalledWith('orion');
    expect(h.navigate).toHaveBeenCalledWith('/m/session/s%2F2%3F%23');
    expect(h.project.mock.invocationCallOrder[0]).toBeLessThan(h.navigate.mock.invocationCallOrder[0]);
  });

  it('routes cross-project approvals and sessions summary without inventing a session', async () => {
    await act(async () => { await h.action?.({ kind: 'approvals', approvalId: 'apr/2?', scope: 'current' }); });
    expect(h.project).toHaveBeenCalledWith('other-project');
    expect(h.navigate).toHaveBeenLastCalledWith('/m/approvals?approvalId=apr%2F2%3F');
    await act(async () => { await h.action?.({ kind: 'sessions', scope: 'current' }); });
    expect(h.navigate).toHaveBeenLastCalledWith('/m/sessions');
    expect(h.sessions).not.toHaveBeenCalled();
  });

  it('falls back for deleted or malformed targets and accepts legacy reply extras', async () => {
    await act(async () => { await h.action?.({ kind: 'session', sessionId: 'deleted' }); });
    expect(h.navigate).toHaveBeenLastCalledWith('/m/sessions');
    await act(async () => { await h.action?.({ kind: 'approvals', approvalId: {} }); });
    expect(h.navigate).toHaveBeenLastCalledWith('/m/approvals');
    await act(async () => { await h.action?.({ sessionId: 's1', projectId: 'atlas' }); });
    expect(h.navigate).toHaveBeenLastCalledWith('/m/session/s1');
  });

  it('ignores wrong-server actions and actions completing after unmount', async () => {
    await act(async () => { await h.action?.({ kind: 'sessions', scope: 'old' }); });
    expect(h.navigate).not.toHaveBeenCalled();
    let resolve!: (value: unknown[]) => void;
    h.sessions.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = h.action?.({ kind: 'session', sessionId: 's1', scope: 'current' });
    act(() => mounted.unmount());
    resolve([{ sessionId: 's1', projectId: 'atlas' }]);
    await pending;
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it('routes in-app replies and dismisses the activated toast', () => {
    act(() => h.toaster?.onActivate(item()));
    expect(h.navigate).toHaveBeenCalledWith('/m/session/s1');
    expect(h.dismiss).toHaveBeenCalledWith('n1');
  });
});
