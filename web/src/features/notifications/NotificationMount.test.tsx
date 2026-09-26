// input:  react-test-renderer, NotificationMount
// output: Desktop layout notification integration tests
// pos:    Feed delivery, foreground suppression and click routes
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
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
  sessions: vi.fn(),
  notices: [] as Array<{ onclick: null | (() => void); close: () => void }>,
  focus: vi.fn(),
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

vi.mock('@/lib/trpc', () => ({
  useTRPCClient: () => ({ sessions: { list: { query: harness.sessions } } }),
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
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true }));
  vi.stubGlobal('window', Object.assign(new EventTarget(), { focus: harness.focus }));
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('isSecureContext', true);
  harness.notices = [];
  vi.stubGlobal('Notification', class {
    static permission = 'granted'; onclick = null; close = vi.fn();
    constructor() { harness.notices.push(this); }
  });
  harness.sessions.mockResolvedValue([{ sessionId: 'session-1', projectId: 'real-project' }]);
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
  vi.unstubAllGlobals();
});

describe('NotificationMount', () => {
  it('injects only the selected workbench session as open', () => {
    expect(harness.feedOptions?.externalDelivery).toBeTypeOf('function');
    expect(harness.feedOptions?.isSessionOpen('open-session')).toBe(true);
    expect(harness.feedOptions?.isSessionOpen('other')).toBe(false);

    harness.pathname = '/settings';
    act(() => { mounted?.update(<NotificationMount />); });
    expect(harness.feedOptions?.isSessionOpen('open-session')).toBe(false);
  });

  it('suppresses selected sessions only when visible AND focused', () => {
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => true });
    expect(harness.feedOptions?.isSessionOpen('open-session')).toBe(false);
    vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => false });
    expect(harness.feedOptions?.isSessionOpen('open-session')).toBe(false);
  });

  it('uses OS delivery only in background and routes clicks using authoritative sessions', async () => {
    await expect(harness.feedOptions?.externalDelivery?.(item())).resolves.toBe(false);
    expect(harness.notices).toHaveLength(0);
    vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => false });
    await expect(harness.feedOptions?.externalDelivery?.(item())).resolves.toBe(true);
    await act(async () => { harness.notices[0].onclick?.(); });
    expect(harness.focus).toHaveBeenCalled();
    expect(harness.setCurrentProject).toHaveBeenCalledWith('real-project');
    expect(harness.setSelectedSession).toHaveBeenCalledWith('session-1');
    expect(harness.navigate).toHaveBeenCalledWith('/workbench');
    expect(harness.toasts).toHaveLength(0);
  });

  it.each(['denied', 'default', 'unsupported', 'disabled', 'failed'])('returns to feed fallback for %s', async (state) => {
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
    const constructors: Record<string, unknown> = {
      denied: Object.assign(class {}, { permission: 'denied' }),
      default: Object.assign(class {}, { permission: 'default' }),
      unsupported: undefined,
      failed: Object.assign(class { constructor() { throw new Error('failed'); } }, { permission: 'granted' }),
    };
    if (state === 'disabled') vi.stubGlobal('localStorage', { getItem: () => 'false' });
    else vi.stubGlobal('Notification', constructors[state]);
    await expect(harness.feedOptions?.externalDelivery?.(item())).resolves.toBe(false);
  });

  it('focuses system notices without querying or navigating a session', async () => {
    harness.sessions.mockClear();
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
    await harness.feedOptions?.externalDelivery?.(item({ sessionId: '' }));
    await act(async () => { harness.notices[0].onclick?.(); });
    expect(harness.sessions).not.toHaveBeenCalled();
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  it.each(['deleted', '\u0000invalid'])('does not select a %s target', async (sessionId) => {
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
    await harness.feedOptions?.externalDelivery?.(item({ sessionId }));
    await act(async () => { harness.notices[0].onclick?.(); });
    expect(harness.setSelectedSession).not.toHaveBeenCalled();
    expect(harness.navigate).toHaveBeenCalledWith('/workbench');
  });

  it('does not route a lookup completing after a connection change', async () => {
    let resolve!: (value: unknown[]) => void;
    harness.sessions.mockImplementation(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
    await harness.feedOptions?.externalDelivery?.(item());
    harness.notices[0].onclick?.();
    vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://other', token: 'new' });
    await act(async () => { resolve([{ sessionId: 'session-1', projectId: 'real-project' }]); });
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  it('routes retained desktop activation into project/session and acknowledges it', async () => {
    act(() => mounted?.unmount());
    vi.stubGlobal('__CORTEX_DESKTOP__', true);
    vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://a', token: 'one' });
    const action = { actionId: 'a1', serverUrl: 'https://a', sessionId: 'session-1' };
    const invoke = vi.fn(async (command) => command === 'desktop_notifications_pending' ? { actions: [action] } : undefined);
    vi.stubGlobal('__TAURI__', { core: { invoke }, event: { listen: async () => vi.fn() } });
    await act(async () => { mounted = create(<NotificationMount />); });
    expect(harness.setCurrentProject).toHaveBeenCalledWith('real-project');
    expect(harness.setSelectedSession).toHaveBeenCalledWith('session-1');
    expect(harness.navigate).toHaveBeenCalledWith('/workbench');
    expect(invoke).toHaveBeenLastCalledWith('desktop_notifications_ack', { actionId: 'a1' });
  });

  it('does not route a lookup completing after unmount', async () => {
    let resolve!: (value: unknown[]) => void;
    harness.sessions.mockImplementation(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
    await harness.feedOptions?.externalDelivery?.(item());
    harness.notices[0].onclick?.();
    act(() => mounted?.unmount());
    await act(async () => { resolve([{ sessionId: 'session-1', projectId: 'real-project' }]); });
    expect(harness.navigate).not.toHaveBeenCalled();
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
