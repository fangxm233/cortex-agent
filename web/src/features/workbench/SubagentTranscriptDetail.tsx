// input:  expanded subagent identity, lazy detail query, and row renderer
// output: expansion-scoped detail rows with minimal loading and retry states
// pos:    Shared lazy subagent transcript detail loader
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useEffect, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLang } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import type { TranscriptMessage } from '@cortex-agent/ui-contract';
import { buildTranscriptRows, type ChatRow } from './transcript-vm';

const activeBySession = new Map<string, Map<string, number>>();

export function registerActiveSubagentTranscript(sessionId: string, subagentId: string): () => void {
  if (!sessionId || !subagentId) return () => {};
  const session = activeBySession.get(sessionId) ?? new Map<string, number>();
  session.set(subagentId, (session.get(subagentId) ?? 0) + 1);
  activeBySession.set(sessionId, session);
  return () => {
    const current = activeBySession.get(sessionId);
    if (!current) return;
    const next = (current.get(subagentId) ?? 1) - 1;
    if (next > 0) current.set(subagentId, next);
    else current.delete(subagentId);
    if (current.size === 0) activeBySession.delete(sessionId);
  };
}

export function activeSubagentTranscriptIds(sessionId: string): string[] {
  return [...(activeBySession.get(sessionId)?.keys() ?? [])];
}

function rootDetailMessage(message: TranscriptMessage): TranscriptMessage {
  const {
    subagentId: _subagentId,
    subagentType: _subagentType,
    subagentDescription: _subagentDescription,
    subagentModel: _subagentModel,
    subagentSpawns: _subagentSpawns,
    ...root
  } = message;
  return root;
}

function detailRows(sessionId: string, messages: TranscriptMessage[] | undefined): ChatRow[] {
  if (!messages?.length) return [];
  const rootMessages = messages.map(rootDetailMessage);
  return buildTranscriptRows({ sessionId, turns: [{ turnIndex: 0, messages: rootMessages }] }, [], { running: false })
    .filter((row) => row.kind !== 'divider');
}

function StatusLine({ children }: { children: ReactNode }): JSX.Element {
  return <div style={{ fontSize: 11.5, color: 'var(--proto-muted-3)' }}>{children}</div>;
}

export function SubagentTranscriptDetail({ sessionId, subagentId, fallbackRows = [], render }: {
  sessionId: string;
  subagentId: string;
  fallbackRows?: ChatRow[];
  render: (rows: ChatRow[]) => ReactNode;
}): JSX.Element | null {
  const trpc = useTRPC();
  const lang = useLang();

  useEffect(() => registerActiveSubagentTranscript(sessionId, subagentId), [sessionId, subagentId]);

  const query = useQuery({
    ...trpc.sessions.subagentTranscript.queryOptions({ sessionId, subagentId }),
    enabled: !!sessionId && !!subagentId,
    retry: false,
  });
  const rows = useMemo(
    () => detailRows(sessionId, query.data?.messages),
    [sessionId, query.data?.messages],
  );

  if (query.isPending && fallbackRows.length > 0) return <>{render(fallbackRows)}</>;
  if (query.isPending) {
    return <StatusLine>{lang === 'zh' ? '加载详情中…' : 'Loading detail…'}</StatusLine>;
  }
  if (query.isError) {
    return (
      <>
        {fallbackRows.length > 0 ? render(fallbackRows) : null}
        <StatusLine>
          {lang === 'zh' ? '详情加载失败。' : 'Failed to load detail.'}{' '}
          <button
            type="button"
            onClick={() => { void query.refetch(); }}
            style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--proto-accent)', cursor: 'pointer' }}
          >
            {lang === 'zh' ? '重试' : 'Retry'}
          </button>
        </StatusLine>
      </>
    );
  }
  const visibleRows = rows.length > 0 ? rows : fallbackRows;
  return visibleRows.length > 0 ? <>{render(visibleRows)}</> : null;
}
