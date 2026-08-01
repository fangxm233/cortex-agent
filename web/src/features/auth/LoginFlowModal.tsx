// input:  auth tRPC procedures, LoginFlow metadata, modal primitives
// output: Accessible resumable OAuth/API-key login dialog
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
import type {
  AuthAccountStatus,
  AuthType,
  LoginFlowNotice,
  LoginFlowState,
} from '@cortex-agent/ui-contract';
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
  capabilities: AuthType[];
}

interface LoginController {
  backend: 'claude' | 'pi';
  authType: AuthType;
  authTypes: AuthType[];
  provider: string;
  providers: ProviderOption[];
  latest: LoginFlowState | null;
  response: string;
  error: string | null;
  canCancel: boolean;
  canStart: boolean;
  chooseBackend: (backend: 'claude' | 'pi') => void;
  chooseProvider: (provider: string) => void;
  chooseAuthType: (authType: AuthType) => void;
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

function NoticeLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-state-run underline">
      {children}
    </a>
  );
}

function InfoNotice({
  notice,
  L,
}: {
  notice: Extract<LoginFlowNotice, { kind: 'info' }>;
  L: Vocab;
}) {
  return (
    <div data-auth-notice="info" className="space-y-1g">
      <p>{notice.message}</p>
      {(notice.links ?? []).map(link => (
        <NoticeLink key={link.url} href={link.url}>{link.label ?? L.authLoginOpenLink}</NoticeLink>
      ))}
    </div>
  );
}

function AuthUrlNotice({
  notice,
  L,
}: {
  notice: Extract<LoginFlowNotice, { kind: 'auth_url' }>;
  L: Vocab;
}) {
  return (
    <div data-auth-notice="auth_url" className="space-y-1g">
      {notice.instructions ? <p>{notice.instructions}</p> : null}
      <NoticeLink href={notice.url}>{L.authLoginOpenAuthorization}</NoticeLink>
    </div>
  );
}

function DeviceCodeNotice({
  notice,
  L,
}: {
  notice: Extract<LoginFlowNotice, { kind: 'device_code' }>;
  L: Vocab;
}) {
  const expiry = notice.expiresInSeconds === undefined
    ? null
    : L.authLoginExpiresIn.replace('{seconds}', String(notice.expiresInSeconds));
  return (
    <div data-auth-notice="device_code" className="space-y-1g">
      <div data-auth-device-code className="font-mono text-xl font-semibold tracking-wider text-state-ink">
        {notice.userCode}
      </div>
      <NoticeLink href={notice.verificationUri}>{L.authLoginOpenVerification}</NoticeLink>
      {expiry ? <p className="text-caption text-state-muted">{expiry}</p> : null}
    </div>
  );
}

function NoticeBody({ state }: { state: LoginFlowState }) {
  const L = useVocab();
  const notice = state.notice;
  if (!notice) return null;
  if (notice.kind === 'info') return <InfoNotice notice={notice} L={L} />;
  if (notice.kind === 'auth_url') return <AuthUrlNotice notice={notice} L={L} />;
  if (notice.kind === 'device_code') return <DeviceCodeNotice notice={notice} L={L} />;
  return (
    <div data-auth-notice="progress" data-auth-progress className="text-state-run" role="status">
      {notice.message}
    </div>
  );
}

function PromptSelect({
  state, value, onChange,
}: {
  state: LoginFlowState; value: string; onChange: (value: string) => void;
}) {
  return (
    <select
      data-auth-secret aria-labelledby="auth-login-prompt-label" value={value}
      onChange={event => onChange(event.target.value)}
      className="w-full rounded-card border border-card bg-surface-card px-2g py-1g text-ui"
    >
      <option value="" />
      {(state.pendingPrompt?.options ?? []).map(option => (
        <option key={option.id} value={option.id}>{option.label}</option>
      ))}
    </select>
  );
}

function PromptControl({
  state, value, onChange,
}: {
  state: LoginFlowState; value: string; onChange: (value: string) => void;
}) {
  const prompt = state.pendingPrompt;
  if (!prompt) return null;
  if (prompt.kind === 'select') {
    return <PromptSelect state={state} value={value} onChange={onChange} />;
  }
  const type = prompt.kind === 'secret' || prompt.kind === 'manual_code' ? 'password' : 'text';
  return (
    <input
      data-auth-secret aria-labelledby="auth-login-prompt-label" type={type}
      value={value} autoComplete="off" onChange={event => onChange(event.target.value)}
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
      {controller.authTypes.length > 1 ? <AuthTypeSelect controller={controller} /> : null}
    </div>
  );
}

function AuthTypeSelect({ controller }: { controller: LoginController }) {
  const L = useVocab();
  return (
    <label className="block space-y-1g text-ui">
      <span>{L.authLoginType}</span>
      <select
        data-auth-type
        value={controller.authType}
        onChange={event => controller.chooseAuthType(event.target.value as AuthType)}
        className="w-full rounded-card border border-card bg-surface-card px-2g py-1g"
      >
        {controller.authTypes.map(authType => (
          <option key={authType} value={authType}>
            {authType === 'api_key'
              ? L.authLoginApiKey
              : controller.backend === 'claude' ? L.authLoginSubscription : L.authLoginOAuth}
          </option>
        ))}
      </select>
    </label>
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
        onChange={event => controller.chooseProvider(event.target.value)}
        className="w-full rounded-card border border-card bg-surface-card px-2g py-1g"
      >
        {controller.providers.map(option => (
          <option key={option.provider} value={option.provider}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function piProviderOptions(accounts: AuthAccountStatus[]): ProviderOption[] {
  return accounts.filter(account => (
    account.backend === 'pi' && account.capabilities.length > 0
  )).map(account => ({
    provider: account.provider,
    label: account.label,
    capabilities: account.capabilities,
  }));
}

function selectedAuthTypes(
  accounts: AuthAccountStatus[],
  providers: ProviderOption[],
  backend: 'claude' | 'pi',
  provider: string,
): AuthType[] {
  const selected = backend === 'claude'
    ? accounts.find(account => account.backend === 'claude' && account.provider === provider)
    : providers.find(option => option.provider === provider);
  return selected?.capabilities ?? [];
}

function useLoginSelection(open: boolean) {
  const trpc = useTRPC();
  const [backend, setBackend] = useState<'claude' | 'pi'>('claude');
  const [authType, setAuthType] = useState<AuthType>('api_key');
  const [provider, setProvider] = useState('anthropic');
  const status = useQuery({ ...trpc.auth.status.queryOptions({}), enabled: open });
  const accounts = status.data?.accounts ?? [];
  const providers = useMemo(() => piProviderOptions(accounts), [accounts]);
  const authTypes = selectedAuthTypes(accounts, providers, backend, provider);
  useEffect(() => {
    if (backend === 'pi' && !providers.some(option => option.provider === provider)) {
      setProvider(providers[0]?.provider ?? '');
    }
  }, [backend, provider, providers]);
  useEffect(() => {
    if (!authTypes.includes(authType) && authTypes[0]) setAuthType(authTypes[0]);
  }, [authType, authTypes]);
  const chooseBackend = (next: 'claude' | 'pi') => {
    setBackend(next);
    setProvider(next === 'claude' ? 'anthropic' : (providers[0]?.provider ?? ''));
  };
  return {
    backend, authType, authTypes, provider, providers, chooseBackend,
    chooseProvider: setProvider, chooseAuthType: setAuthType,
  };
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

type LoginClient = ReturnType<typeof useTRPCClient>;

function isCurrent(input: LoginActionState, request: number): boolean {
  return input.generation.current === request;
}

async function startLogin(client: LoginClient, input: LoginActionState): Promise<void> {
  const request = ++input.generation.current;
  input.setError(null); input.setResponseSent(false);
  try {
    const state = await client.auth.startLogin.mutate({
      backend: input.selection.backend,
      provider: input.selection.provider,
      authType: input.selection.authType,
    });
    if (!isCurrent(input, request)) return;
    input.setFlowId(state.flowId); input.setLatest(state); input.setResponse('');
  } catch (reason) {
    if (isCurrent(input, request)) input.setError(errorMessage(reason));
  }
}

async function submitLogin(client: LoginClient, input: LoginActionState): Promise<void> {
  if (!input.flowId || !input.response) return;
  const request = input.generation.current;
  const value = input.response;
  input.setResponse(''); input.setResponseSent(true); input.setError(null);
  try {
    const state = await client.auth.respondPrompt.mutate({ flowId: input.flowId, value });
    if (isCurrent(input, request)) input.setLatest(state);
  } catch (reason) {
    if (isCurrent(input, request)) input.setError(errorMessage(reason));
  }
}

async function cancelLogin(client: LoginClient, input: LoginActionState): Promise<void> {
  if (!input.flowId) return;
  const request = ++input.generation.current;
  try {
    const state = await client.auth.cancelFlow.mutate({ flowId: input.flowId });
    if (isCurrent(input, request)) input.setLatest(state);
  } catch (reason) {
    if (isCurrent(input, request)) input.setError(errorMessage(reason));
  }
}

function useLoginActions(input: LoginActionState) {
  const client = useTRPCClient();
  return {
    start: () => startLogin(client, input),
    submit: () => submitLogin(client, input),
    cancel: () => cancelLogin(client, input),
  };
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
    canStart: !!selection.provider && selection.authTypes.includes(selection.authType),
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
      {vm.kind === 'notice' ? null : (
        <p id={vm.kind === 'prompt' ? 'auth-login-prompt-label' : undefined}>{vm.message}</p>
      )}
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
    return <Button data-action="auth-start" variant="primary" disabled={!controller.canStart} onClick={controller.start}>{L.authLoginStart}</Button>;
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
