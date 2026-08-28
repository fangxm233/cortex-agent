// input:  mounted project provider with project/session queries and rendered order updates
// output: provider derivation, listing, selection, and ordering regression coverage
// pos:    Current-project context integration specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { CurrentProjectProvider, useCurrentProject } from '@/features/projects/CurrentProjectProvider';

function staticQuery(key: string, value: unknown) {
  return {
    queryOptions: () => ({
      queryKey: [key],
      queryFn: async () => value,
      initialData: value,
    }),
  };
}

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    projects: {
      list: staticQuery('projects.list', [
        { id: 'alpha', kind: 'research', contextDir: '/alpha', hasMission: true, conduits: {} },
        { id: 'beta', kind: 'research', contextDir: '/beta', hasMission: true, conduits: {} },
      ]),
    },
    sessions: {
      list: staticQuery('sessions.list', [
        {
          sessionId: 'old', backendSessionId: null, name: 'old', projectId: 'alpha', backend: 'claude',
          kind: 'local', origin: 'direct', createdAt: '2026-07-01T00:00:00Z',
          lastUsedAt: '2026-07-01T00:00:00Z', resumable: true, label: null, profileName: null,
          running: false, backgroundRunning: false, awaitingInput: false, numTurns: null,
          costUsd: null, unread: false, scheduleId: null,
        },
        {
          sessionId: 'new', backendSessionId: null, name: 'new', projectId: 'beta', backend: 'claude',
          kind: 'local', origin: 'direct', createdAt: '2026-07-02T00:00:00Z',
          lastUsedAt: '2026-07-02T00:00:00Z', resumable: true, label: null, profileName: null,
          running: false, backgroundRunning: false, awaitingInput: false, numTurns: null,
          costUsd: null, unread: false, scheduleId: null,
        },
      ]),
    },
  }),
}));

let observed: ReturnType<typeof useCurrentProject> | null = null;

function Probe() {
  observed = useCurrentProject();
  return null;
}

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('CurrentProjectProvider', () => {
  it('derives the latest session project and then preserves an explicit selection', async () => {
    await act(async () => {
      create(
        <Wrapper>
          <CurrentProjectProvider><Probe /></CurrentProjectProvider>
        </Wrapper>,
      );
    });

    expect(observed?.currentProjectId).toBe('beta');
    expect(observed?.projects.map((project) => project.id)).toEqual(['alpha', 'beta']);

    act(() => observed?.setCurrentProject('alpha'));
    act(() => observed?.setProjectOrder(['beta', 'alpha']));

    expect(observed?.currentProjectId).toBe('alpha');
    expect(observed?.projectOrder).toEqual(['beta', 'alpha']);
  });
});
