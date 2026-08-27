// input:  Selected mobile session id, thread queries, and localized labels
// output: Live inline thread stepper for the selected chat session
// pos:    Mobile chat session-thread presentation boundary
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTRPC } from '@/lib/trpc';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { threadPill } from '@/features/workbench/thread-card-proto';
import { buildMobileStepper } from '@/mobile/screens/mobile-session-vm';
import { MobileThreadStepper } from '@/mobile/screens/MobileThreadStepper';

export function MChatInlineThreadCard({ sessionId, subthreadsLabel, openLabel }: {
  sessionId: string;
  subthreadsLabel: string;
  openLabel: string;
}): JSX.Element | null {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const listQuery = useQuery({ ...trpc.threads.list.queryOptions({ status: ['running', 'waiting'], sessionId }), enabled: !!sessionId });
  const threads = listQuery.data ?? [];
  const target = threads.find((thread) => thread.status === 'running') ?? threads[0] ?? null;
  const threadId = target?.id ?? '';
  useThreadGetLiveSync(threadId);
  const getQuery = useQuery({ ...trpc.threads.get.queryOptions({ threadId }), enabled: !!threadId });
  if (!threadId || getQuery.isPending || getQuery.isError || !getQuery.data) return null;
  return <MobileThreadStepper card={buildMobileStepper(getQuery.data)} pill={threadPill(getQuery.data.status)} subthreadsLabel={subthreadsLabel} openLabel={openLabel} onOpen={() => navigate(`/m/thread/${threadId}`)} />;
}
