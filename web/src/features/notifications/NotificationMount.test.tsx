import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToastInput } from '@/design';
import type { UseNotificationFeedOptions } from './useNotificationFeed';
import type { NotificationItem } from './notification-vm';

const harness = vi.hoisted(() => ({
  pathname: '/workbench',
  selectedSessionId: 'open-session' as string | null,
  feedOptions: null as UseNotificationFeedOptions | null,
  toasts: [] as ToastInput[],
  navigate: vi.fn(),
  setSelectedSession: vi.fn(),
  setCurrentProject: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: harness.pathname }),
  useNavigate: () => harness.navigate,
}));

vi.mock('@/design', () => ({
  useToast: () => ({
    toast: (input: ToastInput) => { harness.toasts.push(input); return 'toast-0'; },
    dismiss: vi.fn(),
    items: [],
  }),
}));

vi.mock('@/features/session/state/SelectedSessionProvider', () => ({
  useSelectedSession: () => ({
    selectedSessionId: harness.selectedSessionId,
    setSelectedSession: harness.setSelectedSession,
  }),
}));

vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ setCurrentProject: harness.setCurrentProject }),
}));

vi.mock('./useNotificationFeed', () => ({
  useNotificationFeed: (options: UseNotificationFeedOptions) => {
    harness.feedOptions = options;
  },
}));

import { NotificationMount } from './NotificationMount';

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'dmn-1', level: 'info', title: 'Inbox', meta: 'Done',
    ts: '2026-08-26T10:00:00.000Z', sessionId: 'session-1', projectId: 'atlas',
    ...overrides,
  };
}

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  harness.pathname = '/workbench';
  harness.selectedSessionId = 'open-session';
  harness.feedOptions = null;
  harness.toasts = [];
  harness.navigate.mockReset();
  harness.setSelectedSession.mockReset();
  harness.setCurrentProject.mockReset();
  act(() => { mounted = create(<NotificationMount />); });
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
});

describe('NotificationMount', () => {
  it('injects only the selected workbench session as open', () => {
    expect(harness.feedOptions?.externalDelivery).toBeUndefined();
    expect(harness.feedOptions?.isSessionOpen('open-session')).toBe(true);
    expect(harness.feedOptions?.isSessionOpen('other')).toBe(false);

    harness.pathname = '/settings';
    act(() => { mounted?.update(<NotificationMount />); });
    expect(harness.feedOptions?.isSessionOpen('open-session')).toBe(false);
  });

  it('publishes a DM reply onto the shared queue, activating into its session', () => {
    act(() => harness.feedOptions?.publish(item()));

    expect(harness.toasts).toHaveLength(1);
    expect(harness.toasts[0]).toMatchObject({
      title: 'Inbox',
      description: 'Done',
      level: 'info',
      ts: '2026-08-26T10:00:00.000Z',
      duration: 6000,
    });

    act(() => harness.toasts[0].onActivate?.());
    expect(harness.setCurrentProject).toHaveBeenCalledWith('atlas');
    expect(harness.setSelectedSession).toHaveBeenCalledWith('session-1');
    expect(harness.navigate).toHaveBeenCalledWith('/workbench');
  });

  it('publishes a system notice as resident and inert (no session to open)', () => {
    act(() => harness.feedOptions?.publish(
      item({ id: 'sysn-2', level: 'error', title: 'Disk', meta: 'Low space', sessionId: '', projectId: null }),
    ));

    expect(harness.toasts[0]).toMatchObject({ title: 'Disk', level: 'error', duration: Infinity });
    expect(harness.toasts[0].onActivate).toBeUndefined();
  });
});
