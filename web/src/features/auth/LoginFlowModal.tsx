// input:  auth tRPC procedures, LoginFlow metadata, modal primitives
// output: accessible masked login dialog with safe cancellation
// pos:    Shared desktop/mobile Web authentication workflow
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginFlowState } from '@cortex-agent/ui-contract';
import { Button, Modal } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC, useTRPCClient } from '@/lib/trpc';
import { buildLoginFlowVm, type LoginFlowVm } from './login-flow-vm';

const FLOW_POLL_MS = 500;
const TERMINAL_STEPS = new Set(['done', 'failed', 'cancelled']);

type Setter<T> = Dispatch<SetStateAction<T>>;

export interface LoginFlowModalProps {
  open: boolean;
  onClose: () => void;
}

interface ProviderOption {
  provider: string;
  label: string;
}

interface LoginController {
  backend: 'claude' | 'pi';
  provider: string;
  providers: ProviderOption[];
  latest: LoginFlowState | null;
  response: string;
  error: string | null;
  canCancel: boolean;
  chooseBackend: (backend: 'claude' | 'pi') => void;
  setProvider: (provider: string) => void;
  setResponse: (value: string) => void;
  start: () => Promise<void>;
  submit: () => Promise<void>;
  cancel: () => Promise<void>;
}

function isTerminal(state: LoginFlowState | null): boolean {
  return !!state && TERMINAL_STEPS.has(state.step);
}

function expiredState(state: LoginFlowState): LoginFlowState {
  return {
    ...state,
    step: 'failed',
    pendingPrompt: null,
    notice: null,
    outcome: null,
    error: null,
    errorCode: 'flow_not_found',
  };
}

function isStateRegression(
  current: LoginFlowState | null,
  incoming: LoginFlowState,
  responseSent: boolean,
): boolean {
  if (!current) return false;
  if (isTerminal(current) && !isTerminal(incoming)) return true;
  return responseSent && current.step === 'running' && incoming.step === 'prompt';
}

function NoticeBody({ state }: { state: LoginFlowState }) {
  const notice = state.notice;
  if (!notice) return null;
  if (notice.kind === 'auth_url') {
    return <a href={notice.url} target="_blank" rel="noreferrer" className="text-state-run underline">{notice.url}</a>;
  }
  if (notice.kind === 'device_code') {
    return (
      <div className="space-y-1g">
        <div className="font-mono text-body text-state-ink">{notice.userCode}</div>
        <a href={notice.verificationUri} target="_blank" rel="noreferrer" className="text-state-run underline">
          {notice.verificationUri}
        </a>
      </div>
    );
  }
  return null;
}

function PromptControl({
  state,
  value,
  onChange,
}: {
  state: LoginFlowState;
  value: string;
  onChange: (value: string) => void;
}) {
  const prompt = state.pendingPrompt;
  if (!prompt) return null;
  if (prompt.kind === 'select') {
    return (
      <select
        data-auth-secret
        aria-labelledby="auth-login-prompt-label"
        value={value}
        onChange={event => onChange(event.target.value)}
        className="w-full rounded-card border border-card bg-surface-card px-2g py-1g text-ui"
      >
        <option value="" />
        {(prompt.options ?? []).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    );
  }
  const type = prompt.kind === 'secret' || prompt.kind === 'manual_code' ? 'password' : 'text';
  return (
    <input
      data-auth-secret
      aria-labelledby="auth-login-prompt-label"
      type={type}
      value={value}
      autoComplete="off"
      onChange={event => onChange(event.target.value)}
      className="w-full rounded-card border border-card bg-surface-card px-2g py-1g text-ui"
    />
  );
}

function SelectionBody({ controller }: { controller: LoginController }) {
  const L = useVocab();
  return (
    <div className="space-y-2g">
      <label className="block space-y-1g text-ui">
        <span>{L.authLoginBackend}</span>
        <select
          data-auth-backend
          value={controller.backend}
          onChange={event => controller.chooseBackend(event.target.value as 'claude' | 'pi')}
          className="w-full rounded-card border border-card bg-surface-card px-2g py-1g"
        >
          <option value="claude">Claude Code</option>
          <option value="pi">PI</option>
        </select>
      </label>
      {controller.backend === 'pi' ? <ProviderSelect controller={controller} /> : null}
    </div>
  );
}

function ProviderSelect({ controller }: { controller: LoginController }) {
  const L = useVocab();
  return (
    <label className="block space-y-1g text-ui">
      <span>{L.authLoginProvider}</span>
      <select
        data-auth-provider
        value={controller.provider}
        onChange={event => controller.setProvider(event.target.value)}
        className="w-full rounded-card border border-card bg-surface-card px-2g py-1g"
      >
        {controller.providers.map(option => (
          <option key={option.provider} value={option.provider}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function useLoginSelection(open: boolean) {
  const trpc = useTRPC();
  const [backend, setBackend] = useState<'claude' | 'pi'>('claude');
  const [provider, setProvider] = useState('anthropic');
  const status = useQuery({ ...trpc.auth.status.queryOptions({}), enabled: open });
  const providers = useMemo(() => (status.data?.accounts ?? [])
    .filter(account => account.backend === 'pi' && account.capabilities.includes('api_key'))
    .map(account => ({ provider: account.provider, label: account.label })), [status.data]);
  useEffect(() => {
    if (backend === 'pi' && !provider && providers[0]) setProvider(providers[0].provider);
  }, [backend, provider, providers]);
  const chooseBackend = (next: 'claude' | 'pi') => {
    setBackend(next);
    setProvider(next === 'claude' ? 'anthropic' : (providers[0]?.provider ?? ''));
  };
  return { backend, provider, providers, chooseBackend, setProvider };
}

function useFlowData(
  open: boolean,
  flowId: string | null,
  latest: LoginFlowState | null,
  responseSent: boolean,
  setLatest: Setter<LoginFlowState | null>,
): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const flow = useQuery({
    ...trpc.auth.flowState.queryOptions({ flowId: flowId ?? '' }),
    enabled: open && !!flowId,
    refetchInterval: open && flowId && !isTerminal(latest) ? FLOW_POLL_MS : false,
  });
  useEffect(() => {
    if (flow.data && !isStateRegression(latest, flow.data, responseSent)) {
      setLatest(flow.data);
    } else if (!flow.data && flow.isSuccess && flowId && latest && !isTerminal(latest)) {
      setLatest(expiredState(latest));
    }
  }, [flow.data, flow.isSuccess, flowId, latest, responseSent, setLatest]);
  useEffect(() => {
    if (latest?.step === 'done') {
      void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
    }
  }, [latest?.step, queryClient, trpc.auth.status]);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

interface LoginActionState {
  selection: ReturnType<typeof useLoginSelection>;
  flowId: string | null;
  response: string;
  generation: { current: number };
  setFlowId: Setter<string | null>;
  setLatest: Setter<LoginFlowState | null>;
  setResponse: Setter<string>;
  setResponseSent: Setter<boolean>;
  setError: Setter<string | null>;
}

function useLoginActions(input: LoginActionState) {
  const client = useTRPCClient();
  const current = (request: number) => input.generation.current === request;
  const start = async () => {
    const request = ++input.generation.current;
    input.setError(null); input.setResponseSent(false);
    try {
      const state = await client.auth.startLogin.mutate({
        backend: input.selection.backend, provider: input.selection.provider, authType: 'api_key',
      });
      if (!current(request)) return;
      input.setFlowId(state.flowId); input.setLatest(state); input.setResponse('');
    } catch (reason) {
      if (current(request)) input.setError(errorMessage(reason));
    }
  };
  const submit = async () => {
    if (!input.flowId || !input.response) return;
    const request = input.generation.current;
    const value = input.response;
    input.setResponse(''); input.setResponseSent(true); input.setError(null);
    try {
      const state = await client.auth.respondPrompt.mutate({ flowId: input.flowId, value });
      if (current(request)) input.setLatest(state);
    } catch (reason) {
      if (current(request)) input.setError(errorMessage(reason));
    }
  };
  const cancel = async () => {
    if (!input.flowId) return;
    const request = ++input.generation.current;
    try {
      const state = await client.auth.cancelFlow.mutate({ flowId: input.flowId });
      if (current(request)) input.setLatest(state);
    } catch (reason) {
      if (current(request)) input.setError(errorMessage(reason));
    }
  };
  return { start, submit, cancel };
}

function useLoginController(open: boolean): LoginController {
  const selection = useLoginSelection(open);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [latest, setLatest] = useState<LoginFlowState | null>(null);
  const [response, setResponse] = useState('');
  const [responseSent, setResponseSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useFlowData(open, flowId, latest, responseSent, setLatest);
  const actions = useLoginActions({
    selection, flowId, response, generation,
    setFlowId, setLatest, setResponse, setResponseSent, setError,
  });
  useEffect(() => {
    if (open) return;
    setFlowId(null); setLatest(null); setResponse(''); setError(null);
    generation.current += 1;
    setResponseSent(false);
  }, [open]);
  return {
    ...selection, latest, response, error,
    canCancel: !responseSent,
    setResponse,
    ...actions,
  };
}

function modalBody(controller: LoginController, vm: LoginFlowVm) {
  if (vm.kind === 'selection') {
    return (
      <div className="space-y-2g">
        <SelectionBody controller={controller} />
        {controller.error ? <p role="alert" className="text-state-fail">{controller.error}</p> : null}
      </div>
    );
  }
  return (
    <div className="space-y-2g" data-auth-flow-step={vm.kind}>
      <p id={vm.kind === 'prompt' ? 'auth-login-prompt-label' : undefined}>{vm.message}</p>
      {controller.error ? <p role="alert" className="text-state-fail">{controller.error}</p> : null}
      {controller.latest ? <NoticeBody state={controller.latest} /> : null}
      {controller.latest ? (
        <PromptControl state={controller.latest} value={controller.response} onChange={controller.setResponse} />
      ) : null}
    </div>
  );
}

function modalFooter(
  controller: LoginController,
  vm: LoginFlowVm,
  onClose: () => void,
  L: Vocab,
) {
  if (vm.kind === 'selection') {
    return <Button data-action="auth-start" variant="primary" disabled={!controller.provider} onClick={controller.start}>{L.authLoginStart}</Button>;
  }
  if (vm.kind === 'prompt') {
    return <>{controller.canCancel ? <Button data-action="auth-cancel" onClick={controller.cancel}>{L.cancel}</Button> : null}<Button data-action="auth-submit" variant="primary" disabled={!controller.response} onClick={controller.submit}>{L.authLoginSubmit}</Button></>;
  }
  if (vm.terminal) return <Button data-action="auth-close" onClick={onClose}>{L.authLoginClose}</Button>;
  if (controller.canCancel) {
    return <Button data-action="auth-cancel" onClick={controller.cancel}>{L.cancel}</Button>;
  }
  return null;
}

export function LoginFlowModal({ open, onClose }: LoginFlowModalProps) {
  const L = useVocab();
  const controller = useLoginController(open);
  const vm = buildLoginFlowVm(controller.latest, L);
  return (
    <Modal
      open={open}
      onOpenChange={next => { if (!next) onClose(); }}
      title={vm.title}
      description={vm.message}
      footer={modalFooter(controller, vm, onClose, L)}
    >
      {modalBody(controller, vm)}
    </Modal>
  );
}
