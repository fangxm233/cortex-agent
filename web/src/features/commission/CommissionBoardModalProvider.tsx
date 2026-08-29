// input:  commission tRPC queries/mutations, member sessions and CommissionBoardModal
// output: AppShell-level commission board provider and its open API
// pos:    Opens the commission board globally from the rail and the chat banner (DR-0037)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useAllSessions } from '@/features/projects/useProjectSessions';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from '@/features/workbench/SelectedSessionProvider';
import { CommissionBoardModal } from './CommissionBoardModal';

export type CommissionModalAction = { type: 'open'; commissionId: string } | { type: 'close' };

export function nextCommissionRef(
  _current: string | null,
  action: CommissionModalAction,
): string | null {
  return action.type === 'open' ? action.commissionId : null;
}

interface CommissionBoardContextValue {
  openCommission: (commissionId: string) => void;
  closeCommission: () => void;
}

const CommissionBoardContext = createContext<CommissionBoardContextValue | null>(null);

/** Ledger and contract are plain project files, so they ride the existing `memory.file` query
 *  rather than a commission-specific text endpoint. A missing file is a normal state (the ledger is
 *  written after approval), so the error is swallowed into `null` instead of retried. */
function useCommissionText(projectId: string, slug: string, file: 'ledger.md' | 'contract.md') {
  const trpc = useTRPC();
  const enabled = !!projectId && !!slug;
  return useQuery({
    ...trpc.memory.file.queryOptions({ projectId, path: `commissions/${slug}/${file}` }),
    enabled,
    retry: false,
  });
}

function CommissionBoardController({ commissionId, onClose }: {
  commissionId: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { setCurrentProject } = useCurrentProject();
  const { setSelectedSession } = useSelectedSession();

  const commissionQuery = useQuery(trpc.commissions.get.queryOptions({ commissionId }));
  const decisionsQuery = useQuery(trpc.commissions.decisions.queryOptions({ commissionId }));
  const sessionsQuery = useAllSessions('direct');
  const commission = commissionQuery.data ?? null;

  const ledgerQuery = useCommissionText(commission?.projectId ?? '', commission?.slug ?? '', 'ledger.md');
  const contractQuery = useCommissionText(commission?.projectId ?? '', commission?.slug ?? '', 'contract.md');

  const close = useMutation(trpc.commissions.close.mutationOptions({
    onSettled: () => {
      void queryClient.invalidateQueries(trpc.commissions.list.queryFilter());
      void queryClient.invalidateQueries(trpc.commissions.get.queryFilter());
    },
  }));

  const gates = useMemo(
    () => (sessionsQuery.data ?? []).filter((s) => s.commissionId === commissionId && !!s.awaitingInput),
    [sessionsQuery.data, commissionId],
  );

  if (!commission) return null;

  const openSession = (session: SessionInfo) => {
    setCurrentProject(session.projectId);
    setSelectedSession(session.sessionId);
    navigate('/workbench');
    onClose();
  };

  return (
    <CommissionBoardModal
      commission={commission}
      ledger={ledgerQuery.data?.content ?? null}
      contract={contractQuery.data?.content ?? null}
      decisions={decisionsQuery.data ?? []}
      gates={gates}
      pending={close.isPending}
      onOpenSession={openSession}
      onClose={(status, note) => {
        close.mutate({ commissionId, status, note: note || undefined });
      }}
      onDismiss={onClose}
    />
  );
}

export function CommissionBoardModalProvider({ children }: { children: ReactNode }) {
  const [commissionId, dispatch] = useReducer(nextCommissionRef, null);
  const openCommission = useCallback((id: string) => dispatch({ type: 'open', commissionId: id }), []);
  const closeCommission = useCallback(() => dispatch({ type: 'close' }), []);
  const value = useMemo(
    () => ({ openCommission, closeCommission }),
    [openCommission, closeCommission],
  );
  return (
    <CommissionBoardContext.Provider value={value}>
      {children}
      {commissionId && (
        <CommissionBoardController commissionId={commissionId} onClose={closeCommission} />
      )}
    </CommissionBoardContext.Provider>
  );
}

export function useCommissionBoard(): CommissionBoardContextValue {
  const context = useContext(CommissionBoardContext);
  if (!context) throw new Error('useCommissionBoard must be used within a CommissionBoardModalProvider');
  return context;
}
