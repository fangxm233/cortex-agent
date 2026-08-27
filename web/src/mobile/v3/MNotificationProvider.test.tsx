// input:  mocked shared feed, native notification bridge, project scope, and mobile router
// output: mobile permission, external delivery, deep-link, predicate, and toaster wiring regressions
// pos:    Thin-adapter specification for MNotificationProvider
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseNotificationFeedOptions } from '@/features/notifications/useNotificationFeed';
import type { NotificationItem } from '@/features/notifications/notification-vm';
import type { MNotificationToasterProps } from './MNotificationToaster';

const harness = vi.hoisted(() => ({
  pathname: '/m/projects',
  feedOptions: null as UseNotificationFeedOptions | null,
  toasterProps: null as MNotificationToasterProps | null,
  action: null as ((data: Record<string, unknown> | undefined) => void) | null,
  navigate: vi.fn(),
  setCurrentProject: vi.fn(),
  dismiss: vi.fn(),
  ensurePermission: vi.fn(async () => true),
  send: vi.fn(async () => true),
  cleanupAction: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: harness.pathname }),
  useNavigate: () => harness.navigate,
}));

vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ setCurrentProject: harness.setCurrentProject }),
}));

vi.mock('@/features/notifications/useNotificationFeed', () => ({
  useNotificationFeed: (options: UseNotificationFeedOptions) => {
    harness.feedOptions = options;
    return { items: [], dismiss: harness.dismiss };
  },
}));

vi.mock('@/features/notifications/os-notify', () => ({
  ensureOsNotifyPermission: harness.ensurePermission,
  sendOsNotification: harness.send,
  osNotificationSpec: (item: NotificationItem) => ({ title: item.title, body: item.meta }),
  onOsNotificationAction: async (callback: (data: Record<string, unknown> | undefined) => void) => {
    harness.action = callback;
    return harness.cleanupAction;
  },
}));

vi.mock('./MNotificationToaster', () => ({
  MNotificationToaster: (props: MNotificationToasterProps) => {
    harness.toasterProps = props;
    return null;
  },
}));

import { MNotificationProvider } from './MNotificationProvider';

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'dmn-1', level: 'info', title: 'Inbox', meta: 'Done',
    ts: '2026-08-26T10:00:00.000Z', sessionId: 'session-1', projectId: 'atlas',
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

let mounted: ReactTestRenderer | null = null;

beforeEach(async () => {
  harness.pathname = '/m/projects';
  harness.feedOptions = null;
  harness.toasterProps = null;
  harness.action = null;
  harness.navigate.mockReset();
  harness.setCurrentProject.mockReset();
  harness.dismiss.mockReset();
  harness.ensurePermission.mockClear();
  harness.send.mockClear();
  harness.cleanupAction.mockReset();
  act(() => { mounted = create(<MNotificationProvider />); });
  await flush();
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
});

describe('MNotificationProvider', () => {
  it('requests permission and injects route suppression plus OS delivery', async () => {
    expect(harness.ensurePermission).toHaveBeenCalledOnce();
    expect(harness.feedOptions?.isSessionOpen('session-1')).toBe(false);
    harness.pathname = '/m/session/session-1';
    act(() => { mounted?.update(<MNotificationProvider />); });
    expect(harness.feedOptions?.isSessionOpen('session-1')).toBe(true);

    await expect(harness.feedOptions?.externalDelivery?.(item())).resolves.toBe(true);
    expect(harness.send).toHaveBeenCalledWith(
      { title: 'Inbox', body: 'Done' },
      { sessionId: 'session-1', projectId: 'atlas' },
    );
    await expect(harness.feedOptions?.externalDelivery?.(
      item({ sessionId: '', projectId: null }),
    )).resolves.toBe(true);
    expect(harness.send).toHaveBeenLastCalledWith({ title: 'Inbox', body: 'Done' }, undefined);
  });

  it('deep-links native actions and in-app activations, then unregisters actions', () => {
    act(() => harness.action?.({ sessionId: 'session-2', projectId: 'orion' }));
    expect(harness.setCurrentProject).toHaveBeenCalledWith('orion');
    expect(harness.navigate).toHaveBeenCalledWith('/m/session/session-2');

    act(() => harness.toasterProps?.onActivate(item()));
    expect(harness.navigate).toHaveBeenLastCalledWith('/m/session/session-1');
    expect(harness.dismiss).toHaveBeenCalledWith('dmn-1');

    act(() => mounted?.unmount());
    mounted = null;
    expect(harness.cleanupAction).toHaveBeenCalledOnce();
  });
});
