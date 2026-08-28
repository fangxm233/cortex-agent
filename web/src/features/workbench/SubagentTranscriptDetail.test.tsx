// input:  lazy subagent detail mounts, query outcomes, and desktop row rendering
// output: expansion-gated query, loading/error fallback, and ChatRows detail regressions
// pos:    Shared lazy subagent transcript detail contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  queryCalls: [] as any[],
  refetch: vi.fn(),
  queryResult: {
    data: {
      sessionId: 's1',
      subagentId: 'child-1',
      messages: [
        { type: 'tool', text: null, toolName: 'Read', toolInput: 'child.ts', subagentId: 'child-1', ts: '2026-08-01T00:59:59.000Z', elapsedMs: null },
        { type: 'assistant', text: 'child output', toolName: null, toolInput: null, subagentId: 'child-1', subagentType: 'explore', ts: '2026-08-01T01:00:00.000Z', elapsedMs: 1000 },
      ],
    },
    isPending: false,
    isError: false,
    refetch: undefined as any,
  },
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (options: any) => {
      harness.queryCalls.push(options);
      return { ...harness.queryResult, refetch: harness.refetch };
    },
  };
});

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    sessions: {
      subagentTranscript: {
        queryOptions: (input: unknown) => ({ __kind: 'sessions.subagentTranscript', input }),
      },
    },
  }),
  useTRPCClient: () => ({
    sessions: { debugDetails: { query: vi.fn() } },
  }),
}));

import { ChatRows } from './MessageStream';
import { SubagentTranscriptDetail } from './SubagentTranscriptDetail';

function Toggle(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <LangProvider>
      <button type="button" onClick={() => setOpen((value) => !value)}>toggle</button>
      {open ? (
        <SubagentTranscriptDetail
          sessionId="s1"
          subagentId="child-1"
          render={(rows) => <ChatRows rows={rows} streamKey="s1" turnCopy={false} />}
        />
      ) : null}
    </LangProvider>
  );
}

describe('SubagentTranscriptDetail', () => {
  beforeEach(() => {
    harness.queryCalls = [];
    harness.refetch.mockReset();
    harness.queryResult = {
      data: {
        sessionId: 's1',
        subagentId: 'child-1',
        messages: [
          { type: 'tool', text: null, toolName: 'Read', toolInput: 'child.ts', subagentId: 'child-1', ts: '2026-08-01T00:59:59.000Z', elapsedMs: null },
          { type: 'assistant', text: 'child output', toolName: null, toolInput: null, subagentId: 'child-1', subagentType: 'explore', ts: '2026-08-01T01:00:00.000Z', elapsedMs: 1000 },
        ],
      },
      isPending: false,
      isError: false,
      refetch: undefined,
    };
  });

  it('does not mount or query until the block is expanded, then renders desktop ChatRows', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Toggle />);
    });

    expect(harness.queryCalls).toHaveLength(0);

    act(() => renderer.root.findByType('button').props.onClick());

    expect(harness.queryCalls).toHaveLength(1);
    expect(harness.queryCalls[0].input).toEqual({ sessionId: 's1', subagentId: 'child-1' });
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('child output');
    expect(rendered).toContain('1 tool call');
    expect(rendered).not.toContain('"aria-expanded"');
  });

  it('shows a minimal loading placeholder', () => {
    harness.queryResult = {
      data: undefined,
      isPending: true,
      isError: false,
      refetch: undefined,
    } as any;
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <SubagentTranscriptDetail sessionId="s1" subagentId="child-1" render={() => null} />
        </LangProvider>,
      );
    });

    expect(JSON.stringify(renderer.toJSON())).toContain('Loading detail…');
  });

  it('shows a retry button on error', () => {
    harness.queryResult = {
      data: undefined,
      isPending: false,
      isError: true,
      refetch: undefined,
    } as any;
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <SubagentTranscriptDetail sessionId="s1" subagentId="child-1" render={() => null} />
        </LangProvider>,
      );
    });

    const retry = renderer.root.findByProps({ children: 'Retry' });
    act(() => retry.props.onClick());
    expect(harness.refetch).toHaveBeenCalledOnce();
  });
});
