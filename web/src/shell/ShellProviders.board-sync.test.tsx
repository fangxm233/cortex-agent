import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The phone's chat shows its board bar as soon as the session is bound: the board sync lives in the
// providers both chromes mount, not in the desktop rail.

interface SubHandlers { onData: (raw: unknown) => void; onConnectionStateChange: (s: { state: string }) => void; onError: () => void }

const h = vi.hoisted(() => ({
  subs: [] as SubHandlers[],
  invalidate: vi.fn(),
  filter: (name: string) => () => ({ queryKey: [name] }),
  pass: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/trpc', () => {
  const client = { subscribe: { subscribe: (_: unknown, handlers: SubHandlers) => { h.subs.push(handlers); return { unsubscribe: () => {} }; } } };
  const trpc = {
    config: { get: { queryFilter: h.filter('config') } },
    sessions: { list: { queryFilter: h.filter('sessions.list') } },
    boards: {
      list: { queryFilter: h.filter('boards.list') }, get: { queryFilter: h.filter('boards.get') },
      decisions: { queryFilter: h.filter('boards.decisions') }, style: { queryFilter: h.filter('boards.style') },
    },
    memory: { file: { queryFilter: h.filter('memory.file') } },
  };
  return { useTRPCClient: () => client, useTRPC: () => trpc };
});
vi.mock('@tanstack/react-query', () => {
  const queryClient = { invalidateQueries: h.invalidate };
  return { useQueryClient: () => queryClient };
});
vi.mock('@/features/connection/ConnectionStatusProvider', () => ({ ConnectionStatusProvider: h.pass }));
vi.mock('@/features/projects/CurrentProjectProvider', () => ({ CurrentProjectProvider: h.pass }));
vi.mock('@/design/modal-registry', () => ({ ModalRegistryProvider: h.pass }));
vi.mock('@/features/media/MediaViewer', () => ({ MediaViewerProvider: h.pass }));
vi.mock('@/features/media/DocViewer', () => ({ DocViewerProvider: h.pass }));

import { ShellProviders } from './ShellProviders';

const install = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
let mounted: ReactTestRenderer | null = null;
beforeEach(() => {
  h.subs.length = 0;
  h.invalidate.mockClear();
  install('window', new EventTarget());
  install('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
});
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = null;
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

const invalidated = () => h.invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);

describe('board sync in the shared shell providers', () => {
  it('refetches the session list when a session is bound to a board', () => {
    act(() => { mounted = create(<ShellProviders><span /></ShellProviders>); });
    act(() => h.subs[0]!.onData({ type: 'session.board', payload: { sessionId: 's1', channel: 'web' } }));
    expect(invalidated()).toEqual(['sessions.list']);
  });

  it('refetches the board queries on a board update', () => {
    act(() => { mounted = create(<ShellProviders><span /></ShellProviders>); });
    act(() => h.subs[0]!.onData({ type: 'board.updated', payload: { boardId: 'b1', projectId: 'p' } }));
    expect(invalidated()).toEqual(['boards.list', 'boards.get', 'boards.decisions', 'sessions.list', 'memory.file']);
  });

  it('is what the phone shell mounts, and the desktop rail no longer mounts its own', () => {
    const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
    expect(read('../mobile/MobileShell.tsx')).toContain('<ShellProviders>');
    expect(read('../features/workbench/rail/LeftRail.tsx')).not.toContain('useBoardLiveSync');
  });
});
