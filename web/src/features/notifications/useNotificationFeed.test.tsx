// input:  mocked direct sessions, DM turn events, system notices, and external delivery outcomes
// output: unified notification-feed gating, queue, fallback, and unmount regressions
// pos:    Hook integration specification for the shared desktop/mobile notification feed
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmNotificationHandlers } from './useDmNotifications';
import type { SystemNoticeMessage } from './useSystemNotices';
import type { NotificationItem } from './notification-vm';

const harness = vi.hoisted(() => ({
  sessions: [] as Array<{
    sessionId: string;
    label: string | null;
    name: string | null;
    projectId: string | null;
  }>,
  dm: null as DmNotificationHandlers | null,
  notice: null as ((message: SystemNoticeMessage) => void) | null,
  queryInputs: [] as unknown[],
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: harness.sessions }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    sessions: {
      list: {
        queryOptions: (input: unknown) => {
          harness.queryInputs.push(input);
          return { queryKey: ['sessions.list', input] };
        },
      },
    },
  }),
}));

vi.mock('./useDmNotifications', () => ({
  useDmNotifications: (handlers: DmNotificationHandlers) => {
    harness.dm = handlers;
  },
}));

vi.mock('./useSystemNotices', () => ({
  useSystemNotices: (handler: (message: SystemNoticeMessage) => void) => {
    harness.notice = handler;
  },
}));

import {
  useNotificationFeed,
  type NotificationFeed,
  type UseNotificationFeedOptions,
} from './useNotificationFeed';

let feed: NotificationFeed | null = null;
let mounted: ReactTestRenderer | null = null;

function Probe(options: UseNotificationFeedOptions): null {
  feed = useNotificationFeed(options);
  return null;
}

function emitAssistant(sessionId: string, text: string, ts = '2026-08-26T10:00:00.000Z'): void {
  harness.dm?.onMessage({ sessionId, channel: null, text, ts });
}

function endTurn(sessionId: string): void {
  harness.dm?.onTurnEnd(sessionId);
}

function emitNotice(text: string, level: SystemNoticeMessage['level'] = 'info'): void {
  harness.notice?.({ text, level, title: null, ts: '2026-08-26T10:01:00.000Z' });
}

function mountFeed(options: UseNotificationFeedOptions): void {
  act(() => {
    mounted = create(<Probe {...options} />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  feed = null;
  harness.sessions = [
    { sessionId: 'direct-1', label: 'Inbox', name: 'fallback', projectId: 'atlas' },
  ];
  harness.dm = null;
  harness.notice = null;
  harness.queryInputs = [];
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
});

describe('useNotificationFeed', () => {
  it('queries direct sessions, buffers the latest turn message, and applies membership/open gates', () => {
    harness.sessions.push({
      sessionId: 'open-1', label: 'Open', name: 'open', projectId: 'atlas',
    });
    mountFeed({ isSessionOpen: (sessionId) => sessionId === 'open-1' });
    expect(harness.queryInputs).toContainEqual({ origin: 'direct' });

    act(() => {
      emitAssistant('direct-1', 'first');
      emitAssistant('direct-1', 'final');
      endTurn('direct-1');
      emitAssistant('thread-1', 'thread chatter');
      endTurn('thread-1');
      emitAssistant('open-1', 'already visible');
      endTurn('open-1');
    });

    expect(feed?.items).toHaveLength(1);
    expect(feed?.items[0]).toMatchObject({
      id: 'dmn-0',
      title: 'Inbox',
      meta: 'final',
      sessionId: 'direct-1',
      projectId: 'atlas',
    });
  });

  it('queues system notices, dedupes consecutive content, and dismisses by id', () => {
    mountFeed({ isSessionOpen: () => false });

    act(() => {
      emitNotice('Daemon restarted', 'warning');
      emitNotice('Daemon restarted', 'warning');
      emitNotice('Disk low', 'error');
    });

    expect(feed?.items.map((item) => [item.id, item.meta])).toEqual([
      ['sysn-0', 'Daemon restarted'],
      ['sysn-2', 'Disk low'],
    ]);
    act(() => feed?.dismiss('sysn-0'));
    expect(feed?.items.map((item) => item.id)).toEqual(['sysn-2']);
  });

  it('keeps successful external delivery out of app and falls back on false or rejection', async () => {
    const delivered: NotificationItem[] = [];
    const externalDelivery = vi
      .fn<(item: NotificationItem) => Promise<boolean>>()
      .mockImplementationOnce(async (item) => {
        delivered.push(item);
        return true;
      })
      .mockImplementationOnce(async (item) => {
        delivered.push(item);
        return false;
      })
      .mockImplementationOnce(async (item) => {
        delivered.push(item);
        throw new Error('native unavailable');
      });
    mountFeed({ isSessionOpen: () => false, externalDelivery });

    act(() => emitNotice('Delivered outside'));
    await flush();
    expect(feed?.items).toEqual([]);

    act(() => {
      emitAssistant('direct-1', 'Fallback DM');
      endTurn('direct-1');
    });
    await flush();
    act(() => emitNotice('Fallback notice', 'error'));
    await flush();

    expect(delivered.map((item) => item.meta)).toEqual([
      'Delivered outside',
      'Fallback DM',
      'Fallback notice',
    ]);
    expect(feed?.items.map((item) => item.meta)).toEqual(['Fallback DM', 'Fallback notice']);
  });

  it('does not publish an async fallback after unmount', async () => {
    let resolveDelivery: ((delivered: boolean) => void) | null = null;
    const externalDelivery = vi.fn(
      () => new Promise<boolean>((resolve) => { resolveDelivery = resolve; }),
    );
    mountFeed({ isSessionOpen: () => false, externalDelivery });

    act(() => emitNotice('Late fallback'));
    const lastMountedFeed = feed;
    act(() => mounted?.unmount());
    mounted = null;
    await act(async () => {
      resolveDelivery?.(false);
      await Promise.resolve();
    });

    expect(lastMountedFeed?.items).toEqual([]);
  });
});
