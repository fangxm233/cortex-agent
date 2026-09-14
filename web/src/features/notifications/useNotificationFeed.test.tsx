import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmNotificationHandlers } from './useDmNotifications';
import type { SystemNoticeMessage } from './useSystemNotices';
import type { NotificationItem } from './notification-vm';

const harness = vi.hoisted(() => ({
  sessions: undefined as Array<{
    sessionId: string;
    label: string | null;
    name: string | null;
    projectId: string | null;
  }> | undefined,
  refetch: vi.fn(),
  dm: null as DmNotificationHandlers | null,
  notice: null as ((message: SystemNoticeMessage) => void) | null,
  queryInputs: [] as unknown[],
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: harness.sessions, refetch: harness.refetch }),
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
  type UseNotificationFeedOptions,
} from './useNotificationFeed';

/** The feed owns no list any more: it publishes into the shared bubble queue (design/Toast).
 *  These tests capture what it publishes, which is the hook's whole contract. */
type FeedOptions = Omit<UseNotificationFeedOptions, 'publish'>;

const published: NotificationItem[] = [];
let mounted: ReactTestRenderer | null = null;

function probeProps(options: FeedOptions): UseNotificationFeedOptions {
  return { ...options, publish: (item) => { published.push(item); } };
}

function Probe(options: UseNotificationFeedOptions): null {
  useNotificationFeed(options);
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

function mountFeed(options: FeedOptions): void {
  act(() => {
    mounted = create(<Probe {...probeProps(options)} />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  published.length = 0;
  harness.sessions = [
    { sessionId: 'direct-1', label: 'Inbox', name: 'fallback', projectId: 'atlas' },
  ];
  harness.refetch.mockReset();
  harness.refetch.mockResolvedValue({ data: harness.sessions });
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
    harness.sessions!.push({
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

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      id: 'dmn-0',
      title: 'Inbox',
      meta: 'final',
      sessionId: 'direct-1',
      projectId: 'atlas',
    });
  });

  it('keeps a turn across an unready failed lookup and flushes when the query later fills', async () => {
    harness.sessions = undefined;
    harness.refetch.mockRejectedValueOnce(new Error('not ready'));
    const options = { isSessionOpen: () => false };
    mountFeed(options);

    act(() => {
      emitAssistant('late-direct', 'survives retry');
      endTurn('late-direct');
    });
    await flush();
    expect(published).toEqual([]);

    harness.sessions = [
      { sessionId: 'late-direct', label: 'Late inbox', name: null, projectId: 'atlas' },
    ];
    act(() => mounted?.update(<Probe {...probeProps(options)} />));
    expect(published[0]).toMatchObject({ meta: 'survives retry', sessionId: 'late-direct' });
  });

  it('retains an ended turn while the direct map is unknown and flushes after a supplemental query', async () => {
    harness.sessions = [];
    harness.refetch.mockResolvedValueOnce({ data: [
      { sessionId: 'late-direct', label: 'Late inbox', name: null, projectId: 'atlas' },
    ] });
    mountFeed({ isSessionOpen: () => false });

    act(() => {
      emitAssistant('late-direct', 'kept until known');
      endTurn('late-direct');
    });
    expect(published).toEqual([]);
    expect(harness.refetch).toHaveBeenCalledOnce();
    await flush();

    expect(published[0]).toMatchObject({
      title: 'Late inbox', meta: 'kept until known', sessionId: 'late-direct',
    });
  });

  it('drops a confirmed non-direct turn after refresh instead of retaining it indefinitely', async () => {
    harness.sessions = [];
    const options = { isSessionOpen: () => false };
    mountFeed(options);

    act(() => {
      emitAssistant('scheduled-1', 'scheduled chatter');
      endTurn('scheduled-1');
    });
    await flush();
    harness.sessions = [
      { sessionId: 'scheduled-1', label: 'Not direct', name: null, projectId: 'atlas' },
    ];
    act(() => mounted?.update(<Probe {...probeProps(options)} />));

    expect(published).toEqual([]);
  });

  it('consumes a buffered turn when open-session suppression is confirmed without a map entry', async () => {
    harness.sessions = undefined;
    mountFeed({ isSessionOpen: (sessionId) => sessionId === 'open-unknown' });

    act(() => {
      emitAssistant('open-unknown', 'already visible');
      endTurn('open-unknown');
      endTurn('open-unknown');
    });
    await flush();

    expect(published).toEqual([]);
    expect(harness.refetch).not.toHaveBeenCalled();
  });

  it('publishes system notices with their server level, in order', () => {
    // Consecutive-duplicate collapsing now lives in the shared queue (design/toast-store, keyed by
    // dedupeKey) — the feed itself publishes every notice it receives.
    mountFeed({ isSessionOpen: () => false });

    act(() => {
      emitNotice('Daemon restarted', 'warning');
      emitNotice('Disk low', 'error');
    });

    expect(published.map((item) => [item.id, item.meta, item.level])).toEqual([
      ['sysn-0', 'Daemon restarted', 'warning'],
      ['sysn-1', 'Disk low', 'error'],
    ]);
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
    expect(published).toEqual([]);

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
    expect(published.map((item) => item.meta)).toEqual(['Fallback DM', 'Fallback notice']);
  });

  it('does not publish an async fallback after unmount', async () => {
    let resolveDelivery: ((delivered: boolean) => void) | null = null;
    const externalDelivery = vi.fn(
      () => new Promise<boolean>((resolve) => { resolveDelivery = resolve; }),
    );
    mountFeed({ isSessionOpen: () => false, externalDelivery });

    act(() => emitNotice('Late fallback'));
    act(() => mounted?.unmount());
    mounted = null;
    await act(async () => {
      resolveDelivery?.(false);
      await Promise.resolve();
    });

    expect(published).toEqual([]);
  });
});
