// input:  active commissions from trpc.commissions.list, commissionEnabled from trpc.config.get
// output: the commission feature switch, commission-mode options for the composer ＋ menu, and the
//         request they encode
// pos:    Commission-mode choice model (off / new / join an active one)
import { useQuery } from '@tanstack/react-query';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';

/**
 * The global commission feature switch (`settings.commissionEnabled`, on by default — it is the
 * kill switch, not an opt-in). Read from the shared `config.get` snapshot the workbench already
 * holds, so this costs no extra request.
 *
 * Fail-closed: while the snapshot is loading — or if an older server omits the settings array —
 * this reports `false`. Showing the opt-in and then having the server reject the create would be a
 * worse failure than a control that appears a moment late. The server enforces the same switch, so
 * the UI answer is only ever about what is offered, never about what is permitted.
 */
export function useCommissionEnabled(): boolean {
  const trpc = useTRPC();
  const query = useQuery(trpc.config.get.queryOptions({}));
  return query.data?.settings?.some((s) => s.key === 'commissionEnabled' && s.value === true) ?? false;
}

/** What the composer sends with sessions.create / createAndSend. null is "not a commission". */
export type CommissionRequest = { mode: 'new' } | { mode: 'join'; commissionId: string };

export interface CommissionOption {
  /** null is the "off" row; 'new' starts a fresh contract; anything else is a commission id. */
  value: null | 'new' | string;
  label: string;
  sub: string;
}

/** The menu value → the create request. Kept next to the options so the two cannot drift. */
export function commissionRequestOf(value: null | 'new' | string): CommissionRequest | null {
  if (value === null) return null;
  return value === 'new' ? { mode: 'new' } : { mode: 'join', commissionId: value };
}

/** The same value → the switch request for a LIVE session, where "off" is a real instruction
 *  rather than the absence of one (sessions.setCommission). */
export function commissionSwitchOf(
  value: null | 'new' | string,
): { mode: 'off' } | { mode: 'new' } | { mode: 'join'; commissionId: string } {
  return commissionRequestOf(value) ?? { mode: 'off' };
}

/**
 * Commission mode is offered at creation AND on a live session (DR-0037 v4). It is not like the
 * browser opt-in: the mode is registry state rather than a property of the spawned process, so a
 * conversation that turns out to be a long task can be promoted where it stands — the skill arrives
 * with the next spawn and the [Commission] block follows the binding, not the session's first turn.
 *
 * Two ways in. `new` means a long task with no contract yet — a draft directory is created and the
 * agent drills before doing anything. Picking an existing commission is how a commission spans more
 * than one session: a fresh conversation, same contract and ledger.
 *
 * Only active commissions are offered; a closed one is readable but does not take new sessions.
 * The list is read when the menu opens rather than held, so it cannot offer one that has since
 * been closed in another tab.
 */
export function useCommissionOptions(open: boolean): CommissionOption[] {
  const trpc = useTRPC();
  const L = useVocab();
  const query = useQuery({
    ...trpc.commissions.list.queryOptions({ status: 'active' }),
    enabled: open,
  });

  return [
    { value: null, label: L.wbCommissionOffOption, sub: '' },
    { value: 'new', label: L.wbCommissionNewOption, sub: L.wbCommissionNewSub },
    ...(query.data ?? []).map((c) => ({
      value: c.id,
      label: c.title,
      sub: L.wbCommissionJoinSub,
    })),
  ];
}

/** What the capsule on a LIVE session shows: which commission it serves, by title once one has
 *  landed. A session still drilling has a draft directory but no name yet — that is the point of
 *  the drill — so it reports the mode without a title. Returns null outside the mode.
 *
 *  The title query shares its key with the chat banner's, so a bound session pays for it once. */
export function useSessionCommission(session: SessionInfo | null | undefined): {
  value: string;
  label: string | null;
} | null {
  const trpc = useTRPC();
  const commissionId = session?.commissionId ?? null;
  const query = useQuery({
    ...trpc.commissions.get.queryOptions({ commissionId: commissionId ?? '' }),
    enabled: !!commissionId,
  });
  if (commissionId) return { value: commissionId, label: query.data?.title ?? null };
  return session?.commissionDraft ? { value: 'new', label: null } : null;
}
