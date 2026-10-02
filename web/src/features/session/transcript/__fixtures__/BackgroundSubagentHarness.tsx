// Controlled RPC fixture, NOT a backend or HTTP/SSE integration test. The QueryClient,
// tRPC options/keys, live provider, live sync, VM and transcript renderers are production code.
import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, type TRPCLink } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { observable } from '@trpc/server/observable';
import type { AppRouter, SessionTranscript, SessionSubagentTranscript, TranscriptMessage } from '@cortex-agent/ui-contract';
import { TRPCProvider } from '@/lib/trpc';
import { LangProvider } from '@/i18n';
import { LiveEventsProvider } from '@/features/live/LiveEventsProvider';
import type { LiveEvent } from '@/features/live/live-events';
import { useSessionMessageLiveSync } from '@/features/session/live/useSessionMessageLiveSync';
import { useTranscriptQuery } from '../useTranscriptQuery';
import { buildTranscriptRows } from '../transcript-vm';
import { ChatRows } from '../MessageStream';

export const SESSION_ID = 'background-fixture';
export const CHILD_ID = 'agent-call#0';
export const DETAIL_INPUT = { sessionId: SESSION_ID, subagentId: CHILD_ID };

type Status = 'running' | 'completed' | 'failed' | 'killed';
type Delivery = { result: { data: unknown } | { type: 'state'; state: 'pending' | 'connecting'; error: null } };

export function childMessage(sequence: number, patch: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    type: 'assistant', text: null, toolName: null, toolInput: null, elapsedMs: null,
    subagentId: CHILD_ID, ts: `2026-08-01T01:00:${String(sequence).padStart(2, '0')}.000Z`, ...patch,
  };
}

function initialTranscript(): SessionTranscript {
  return {
    sessionId: SESSION_ID,
    turns: [{ turnIndex: 0, messages: [{
      ...childMessage(0, { type: 'tool', toolName: 'agent', subagentId: undefined }),
      subagentSpawns: [{ id: CHILD_ID, type: 'explore', description: 'Background fixture child', prompt: 'Inspect synthetic input.' }],
    }] }],
    subagentSummaries: [{
      id: CHILD_ID, toolCount: 1, hasDetails: true, structurallyOpen: false, status: 'running',
    }],
  };
}

export class BackgroundSubagentFixture {
  readonly queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  readonly transcript = initialTranscript();
  readonly detail: SessionSubagentTranscript = {
    ...DETAIL_INPUT,
    messages: [childMessage(1, { type: 'tool', toolName: 'Read', toolInput: 'early.ts' })],
  };
  readonly calls: string[] = [];
  readonly transcriptInputs: unknown[] = [];
  deltaResponses = false;
  private holdTranscript = false;
  private releaseTranscript: (() => void) | undefined;
  private listeners = new Set<(event: Delivery) => void>();
  private holdDetail = false;
  private releaseDetail: (() => void) | undefined;
  readonly client = createTRPCClient<AppRouter>({ links: [this.link()] });
  readonly trpc = createTRPCOptionsProxy<AppRouter>({ client: this.client, queryClient: this.queryClient });

  private link(): TRPCLink<AppRouter> {
    return () => ({ op }) => observable((observer) => {
      if (op.type === 'subscription') {
        this.listeners.add(observer.next);
        observer.next({ result: { type: 'state', state: 'pending', error: null } });
        return () => { this.listeners.delete(observer.next); };
      }
      this.calls.push(op.path);
      const data = this.response(op.path, op.input);
      const deliver = () => { observer.next({ result: { data } }); observer.complete(); };
      if (op.path === 'sessions.subagentTranscript' && this.holdDetail) {
        this.holdDetail = false;
        this.releaseDetail = deliver;
      } else if (op.path === 'sessions.transcript' && this.holdTranscript) {
        this.holdTranscript = false;
        this.releaseTranscript = deliver;
      } else deliver();
      return () => {};
    });
  }

  private response(path: string, input: unknown): unknown {
    if (path === 'sessions.transcript') return this.transcriptResponse(input);
    if (path === 'sessions.subagentTranscript') return structuredClone(this.detail);
    throw new Error(`Unexpected fixture query: ${path}`);
  }

  private transcriptResponse(input: unknown): SessionTranscript {
    this.transcriptInputs.push(input);
    const snapshot = structuredClone(this.transcript);
    if (!this.deltaResponses) return snapshot;
    snapshot.cursor = 'fixture:1';
    // Child summaries change outside the compact row cursor; the spawn row stays unchanged.
    if ((input as { since?: string }).since) {
      return { ...snapshot, turns: [], delta: { total: 1, changed: [] } };
    }
    return snapshot;
  }

  holdNextTranscript(): void { this.holdTranscript = true; }
  releaseFirstTranscript(): void { this.releaseTranscript?.(); this.releaseTranscript = undefined; }
  transcriptReads(): number { return this.transcriptInputs.length; }

  holdNextDetail(): void { this.holdDetail = true; }
  releaseFirstDetail(): void { this.releaseDetail?.(); this.releaseDetail = undefined; }
  detailReads(): number { return this.calls.filter((path) => path === 'sessions.subagentTranscript').length; }

  emit(type: string, payload: Record<string, unknown> = {}): void {
    const event: LiveEvent = { type, ts: new Date().toISOString(), payload: { sessionId: SESSION_ID, ...payload } };
    for (const next of this.listeners) next({ result: { data: event } });
  }

  messageEvent(message: TranscriptMessage): void {
    this.emit('session.message', { ...message, role: message.type, text: message.text ?? '' });
  }

  append(message: TranscriptMessage, notify = true): void {
    this.detail.messages.push(message);
    this.transcript.subagentSummaries![0].toolCount = this.detail.messages.filter((row) => row.type === 'tool').length;
    if (message.subagentEnded) this.setStatus(message.subagentEnded);
    if (notify) this.messageEvent(message);
  }

  setStatus(status: Status): void { this.transcript.subagentSummaries![0].status = status; }

  reconnect(): void {
    for (const state of ['connecting', 'pending'] as const) {
      for (const next of this.listeners) next({ result: { type: 'state', state, error: null } });
    }
  }
}

// For real-router verification, wrap this component with the normal QueryClient/TRPC/Live
// providers and pass the synthetic backend sessionId. The fixture below replaces only RPC I/O.
export function BackgroundTranscript({ sessionId = SESSION_ID }: { sessionId?: string }): JSX.Element {
  const query = useTranscriptQuery(sessionId);
  const live = useSessionMessageLiveSync(sessionId, false, false, { transcript: query.data });
  const rows = buildTranscriptRows(query.data ?? { sessionId, turns: [] }, live.liveTail, { running: live.running });
  return <>
    <output data-testid="parent-running">{String(live.running)}</output>
    <ChatRows rows={rows} streamKey={sessionId} turnCopy={false} />
  </>;
}

export function BackgroundSubagentHarness({ fixture, children }: {
  fixture: BackgroundSubagentFixture;
  children?: ReactNode;
}): JSX.Element {
  return <QueryClientProvider client={fixture.queryClient}>
    <TRPCProvider trpcClient={fixture.client} queryClient={fixture.queryClient}>
      <LangProvider><LiveEventsProvider>{children}<BackgroundTranscript /></LiveEventsProvider></LangProvider>
    </TRPCProvider>
  </QueryClientProvider>;
}
