import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthType, LoginFlowState } from '@cortex-agent/ui-contract';
import { fmt, useVocab, type Vocab } from '@/i18n';
import { trpcErrorCode, useTRPC, useTRPCClient } from '@/lib/trpc';
import { expiredSnapshot, isTerminal, newerSnapshot } from './login-flow-vm';

export const FLOW_POLL_MS = 1000;

const CLAUDE_LABEL = 'Claude Code';

export interface LoginFlowTarget {
  backend: 'claude' | 'pi';
  provider: string;
  authType: AuthType;
  /** Chat notice that asked for this login; the server resumes or restarts its flow. */
  noticeId?: string;
  /** Display label of the provider, when the caller has it. */
  label?: string;
  /** A named account to sign in again; absent or null is the provider's default login. */
  connection?: string | null;
  /** Register a new account under this name; its first login is the flow. */
  newAccount?: string;
}

export interface LoginFlowController {
  latest: LoginFlowState | null;
  /** Why the flow could not be started. */
  startError: string | null;
  /** Why the last answer was refused; the prompt stays up. */
  respondError: string | null;
  starting: boolean;
  responding: boolean;
  respond: (value: string) => void;
  retry: () => void;
}

type LoginClient = ReturnType<typeof useTRPCClient>;

function errorText(reason: unknown, L: Vocab): string {
  if (trpcErrorCode(reason) === 'NOT_FOUND') return L.authLoginExpired;
  const message = reason instanceof Error ? reason.message : String(reason);
  return message || L.authLoginUnknownFailure;
}

function cancelQuietly(client: LoginClient, state: LoginFlowState | null): void {
  if (state && !isTerminal(state)) void client.auth.cancelFlow.mutate({ flowId: state.flowId }).catch(() => {});
}

function useFlowPolling(
  clientRef: { current: { client: LoginClient } },
  flowId: string | null,
  active: boolean,
  generation: { current: number },
  receive: (flowId: string, state: LoginFlowState | null) => void,
): void {
  useEffect(() => {
    if (!flowId || !active) return undefined;
    const request = generation.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const state = await clientRef.current.client.auth.flowState.query({ flowId });
        if (!stopped && generation.current === request) receive(flowId, state ?? null);
      } catch {
        // A dropped poll is retried on the next tick.
      }
      if (!stopped) timer = setTimeout(tick, FLOW_POLL_MS);
    };
    timer = setTimeout(tick, FLOW_POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [clientRef, flowId, active, generation, receive]);
}

function useDoneInvalidation(state: LoginFlowState | null, onDone?: (state: LoginFlowState) => void): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const reported = useRef<string | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (state?.step !== 'done' || reported.current === state.flowId) return;
    reported.current = state.flowId;
    void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
    void queryClient.invalidateQueries(trpc.connections.list.queryFilter({}));
    void queryClient.invalidateQueries(trpc.config.get.queryFilter({}));
    void queryClient.invalidateQueries(trpc.models.catalog.queryFilter({}));
    doneRef.current?.(state);
  }, [state, queryClient, trpc]);
}

function targetKey(target: LoginFlowTarget | null | undefined): string | null {
  if (!target) return null;
  return [
    target.backend, target.provider, target.authType, target.noticeId ?? '', target.connection ?? '', target.newAccount ?? '',
  ].join('\u0000');
}

/** A new account is registered and signed in by one call; every other login starts its own flow. */
async function startFlow(api: LoginClient, target: LoginFlowTarget): Promise<LoginFlowState> {
  if (target.newAccount) {
    const added = await api.auth.addAccount.mutate({
      backend: target.backend, label: target.newAccount,
      // Claude accounts always sign in with OAuth; a PI account uses the login picked for it.
      ...(target.backend === 'pi' ? { provider: target.provider, authType: target.authType } : {}),
    });
    return added.flow;
  }
  return api.auth.startLogin.mutate({
    backend: target.backend, provider: target.provider, authType: target.authType,
    ...(target.connection ? { connection: target.connection } : {}),
    ...(target.noticeId ? { noticeId: target.noticeId } : {}),
  });
}

/**
 * Drives one login flow for a fixed target: starts it on open, keeps the newest server snapshot
 * by revision, polls while it is unfinished, and cancels it when the dialog closes or the target
 * changes. The generation counter only drops responses that land after a close or a retry.
 */
export function useLoginFlowController(
  open: boolean,
  target: LoginFlowTarget | null | undefined,
  onDone?: (state: LoginFlowState) => void,
): LoginFlowController {
  const L = useVocab();
  const client = useTRPCClient();
  const generation = useRef(0);
  const [latest, setLatest] = useState<LoginFlowState | null>(null);
  const latestRef = useRef(latest);
  latestRef.current = latest;
  const [startError, setStartError] = useState<string | null>(null);
  const [respondError, setRespondError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [responding, setResponding] = useState(false);
  const context = useRef({ target, client, L });
  context.current = { target, client, L };

  const accept = useCallback((request: number, incoming: LoginFlowState) => {
    if (generation.current !== request) return false;
    setLatest(current => newerSnapshot(current, incoming));
    return true;
  }, []);

  const reset = useCallback(() => {
    setLatest(null); setStartError(null); setRespondError(null); setStarting(false); setResponding(false);
  }, []);

  const start = useCallback(async () => {
    const { target: current, client: api, L: vocab } = context.current;
    if (!current) return;
    const request = ++generation.current;
    reset(); setStarting(true);
    try {
      const state = await startFlow(api, current);
      // Closed or restarted while the start was in flight: do not leave the flow running.
      if (!accept(request, state)) cancelQuietly(api, state);
    } catch (reason) {
      if (generation.current === request) setStartError(errorText(reason, vocab));
    } finally {
      if (generation.current === request) setStarting(false);
    }
  }, [accept, reset]);

  const key = targetKey(target);
  useEffect(() => {
    if (!open || !key) return undefined;
    void start();
    return () => {
      generation.current += 1;
      cancelQuietly(context.current.client, latestRef.current);
      reset();
    };
  }, [open, key, start, reset]);

  const receive = useCallback((flowId: string, state: LoginFlowState | null) => {
    if (state) return void setLatest(current => newerSnapshot(current, state));
    setLatest(current => (current?.flowId === flowId && !isTerminal(current) ? expiredSnapshot(current) : current));
  }, []);
  useFlowPolling(context, latest?.flowId ?? null, open && !!latest && !isTerminal(latest), generation, receive);
  useDoneInvalidation(latest, onDone);

  const respond = useCallback((value: string) => {
    const state = latestRef.current;
    const prompt = state?.pendingPrompt;
    if (!state || !prompt) return;
    const { client: api, L: vocab } = context.current;
    const request = generation.current;
    setResponding(true); setRespondError(null);
    void api.auth.respondPrompt.mutate({ flowId: state.flowId, value, promptId: prompt.id })
      .then(next => { accept(request, next); })
      .catch((reason: unknown) => { if (generation.current === request) setRespondError(errorText(reason, vocab)); })
      .finally(() => { if (generation.current === request) setResponding(false); });
  }, [accept]);

  const retry = useCallback(() => { void start(); }, [start]);

  return { latest, startError, respondError, starting, responding, respond, retry };
}

/** The provider's display label: the caller's, Claude Code's, or PI's from the account status; a
 *  named account reads as "Claude Code (School)". */
export function useProviderLabel(open: boolean, target: LoginFlowTarget | null): string | null {
  const L = useVocab();
  const trpc = useTRPC();
  const lookup = open && !!target && !target.label && (target.backend === 'pi' || !!target.connection);
  const status = useQuery({ ...trpc.auth.status.queryOptions({}), enabled: lookup });
  if (!target) return null;
  if (target.label) return target.label;
  const rows = (status.data?.accounts ?? []).filter(account => (
    account.backend === target.backend && account.provider === target.provider
  ));
  const provider = target.backend === 'claude' ? CLAUDE_LABEL : rows.find(row => !row.connection)?.label ?? null;
  const account = target.connection ? rows.find(row => row.connection === target.connection)?.label : undefined;
  return provider && account ? fmt(L.accountsAccountName, { provider, account }) : provider;
}
