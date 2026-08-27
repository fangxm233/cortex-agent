// input:  mocked shared feed, workbench selection, project scope, and desktop router
// output: desktop open-session predicate, activation navigation, and toaster wiring regressions
// pos:    Thin-adapter specification for NotificationProvider
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationToasterProps } from './NotificationToaster';
import type { UseNotificationFeedOptions } from './useNotificationFeed';
import type { NotificationItem } from './notification-vm';

const harness = vi.hoisted(() => ({
  pathname: '/workbench',
  selectedSessionId: 'open-session' as string | null,
  feedOptions: null as UseNotificationFeedOptions | null,
  toasterProps: null as NotificationToasterProps | null,
  navigate: vi.fn(),
  setSelectedSession: vi.fn(),
  setCurrentProject: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: harness.pathname }),
  useNavigate: () => harness.navigate,
}));

vi.mock('@/features/workbench/SelectedSessionProvider', () => ({
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
    return { items: [], dismiss: harness.dismiss };
  },
}));

vi.mock('./NotificationToaster', () => ({
  NotificationToaster: (props: NotificationToasterProps) => {
    harness.toasterProps = props;
    return null;
  },
}));

import { NotificationProvider } from './NotificationProvider';

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
  harness.toasterProps = null;
  harness.navigate.mockReset();
  harness.setSelectedSession.mockReset();
  harness.setCurrentProject.mockReset();
  harness.dismiss.mockReset();
  act(() => { mounted = create(<NotificationProvider />); });
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
});

describe('NotificationProvider', () => {
  it('injects only the selected workbench session as open', () => {
    expect(harness.feedOptions?.externalDelivery).toBeUndefined();
    expect(harness.feedOptions?.isSessionOpen('open-session')).toBe(true);
    expect(harness.feedOptions?.isSessionOpen('other')).toBe(false);

    harness.pathname = '/settings';
    act(() => { mounted?.update(<NotificationProvider />); });
    expect(harness.feedOptions?.isSessionOpen('open-session')).toBe(false);
  });

  it('navigates DM activations and only dismisses system notices', () => {
    act(() => harness.toasterProps?.onActivate(item()));
    expect(harness.setCurrentProject).toHaveBeenCalledWith('atlas');
    expect(harness.setSelectedSession).toHaveBeenCalledWith('session-1');
    expect(harness.navigate).toHaveBeenCalledWith('/workbench');
    expect(harness.dismiss).toHaveBeenCalledWith('dmn-1');

    harness.navigate.mockClear();
    harness.dismiss.mockClear();
    act(() => harness.toasterProps?.onActivate(item({ id: 'sysn-2', sessionId: '', projectId: null })));
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.dismiss).toHaveBeenCalledWith('sysn-2');
  });
});
