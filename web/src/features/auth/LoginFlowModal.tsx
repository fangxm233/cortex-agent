// input:  auth tRPC, LoginFlow metadata, Modal/MBottomSheet
// output: consent-gated responsive OAuth/API-key login overlay
// pos:    Shared desktop/mobile authentication workflow
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuthAccountStatus,
  AuthType,
  LoginFlowNotice,
  LoginFlowState,
} from '@cortex-agent/ui-contract';
import { Button, Modal, Select, type SelectOption } from '@/design';
import { useIsMobile, useVocab, type Vocab } from '@/i18n';
import { openExternalUrl } from '@/lib/external-navigation';
import { useTRPC, useTRPCClient } from '@/lib/trpc';
import { MBottomSheet } from '@/mobile/ui/kit';
import { buildLoginFlowVm, type LoginFlowVm } from './login-flow-vm';

const FLOW_POLL_MS = 500;
const TERMINAL_STEPS = new Set(['done', 'failed', 'cancelled']);

type Setter<T> = Dispatch<SetStateAction<T>>;

export interface LoginFlowTarget {
  backend: 'claude' | 'pi';
  provider: string;
  authType: AuthType;
  noticeId?: string;
}

export interface LoginFlowModalProps {
  open: boolean;
  onClose: () => void;
  target?: LoginFlowTarget | null;
  initialState?: LoginFlowState | null;
  onFlowStateChange?: (state: LoginFlowState) => void;
}

interface ProviderOption {
  provider: string;
  label: string;
  capabilities: AuthType[];
}

interface AuthSelectProps<T extends string> {
  field: 'secret' | 'backend' | 'type' | 'provider';
  value: T;
  options: readonly SelectOption<T>[];
  onValueChange: (value: T) => void;
  className: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  placeholder?: string;
}

function AuthSelect<T extends string>(props: AuthSelectProps<T>): JSX.Element {
  const isMobile = useIsMobile();
  const dataProps = { [`data-auth-${props.field}`]: true };
  if (!isMobile) {
    // `bare` so the class below — shared with the plain text prompt input — owns the whole box; the
    // default compact density is inline and would shrink the selection out of line with it.
    return <Select {...dataProps} density="bare" aria-label={props.ariaLabel}
      aria-labelledby={props.ariaLabelledBy} value={props.value} options={props.options}
      onValueChange={props.onValueChange} placeholder={props.placeholder} className={props.className} />;
  }
  const hasValue = props.options.some((option) => option.value === props.value);
  return (
    <select {...dataProps} aria-label={props.ariaLabel} aria-labelledby={props.ariaLabelledBy}
      value={props.value} onChange={(event) => props.onValueChange(event.target.value as T)}
      className={props.className}>
      {!hasValue ? <option value="">{props.placeholder}</option> : null}
      {props.options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
      ))}
    </select>
  );
}

interface LoginController {
  backend: 'claude' | 'pi';
  authType: AuthType;
  noticeId?: string;
  authTypes: AuthType[];
  provider: string;
  providerLabel: string;
  backendLabel: string;
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

function OpenUrlButton({ href, children, action }: {
  href: string;
  children: string;
  action?: string;
}) {
  return (
    <Button
      data-action={action} data-auth-external-url={href} variant="secondary"
      onClick={() => openExternalUrl(href)}
    >
      {children}<span aria-hidden="true">↗</span>
    </Button>
  );
}

function InfoNotice({ notice, L }: {
  notice: Extract<LoginFlowNotice, { kind: 'info' }>;
  L: Vocab;
}) {
  return (
    <div data-auth-notice="info" className="min-w-0 space-y-1g break-words">
      <p>{notice.message}</p>
      {(notice.links ?? []).map(link => (
        <OpenUrlButton key={link.url} href={link.url}>
          {link.label ?? L.authLoginOpenLink}
        </OpenUrlButton>
      ))}
    </div>
  );
}

const OAUTH_STEP_CLASS =
  'min-w-0 rounded-card border border-proto-line-2 bg-surface-canvas-alt p-2g';

function AuthUrlNotice({ notice, L, hideInstructions }: {
  notice: Extract<LoginFlowNotice, { kind: 'auth_url' }>;
  L: Vocab;
  hideInstructions: boolean;
}) {
  return (
    <section
      data-auth-notice="auth_url" data-auth-open-step className={OAUTH_STEP_CLASS}
    >
      <div className="flex min-w-0 items-start gap-1.5g">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-state-run text-caption font-semibold text-surface-card">1</span>
        <div className="min-w-0 flex-1 space-y-1g break-words">
          <p className="font-medium text-state-ink">{L.authLoginOpenStep}</p>
          {!hideInstructions && notice.instructions ? <p>{notice.instructions}</p> : null}
          <OpenUrlButton href={notice.url} action="auth-open-url">
            {L.authLoginOpenAuthorization}
          </OpenUrlButton>
        </div>
      </div>
    </section>
  );
}

function DeviceCodeNotice({ notice, L }: {
  notice: Extract<LoginFlowNotice, { kind: 'device_code' }>;
  L: Vocab;
}) {
  const expiry = notice.expiresInSeconds === undefined
    ? null
    : L.authLoginExpiresIn.replace('{seconds}', String(notice.expiresInSeconds));
  return (
    <div data-auth-notice="device_code" className="min-w-0 space-y-1g break-words">
      <div data-auth-device-code className="font-mono text-xl font-semibold tracking-wider text-state-ink">
        {notice.userCode}
      </div>
      <OpenUrlButton href={notice.verificationUri}>{L.authLoginOpenVerification}</OpenUrlButton>
      {expiry ? <p className="text-caption text-state-muted">{expiry}</p> : null}
    </div>
  );
}

function NoticeBody({ state }: { state: LoginFlowState }) {
  const L = useVocab();
  const notice = state.notice;
  if (!notice) return null;
  if (notice.kind === 'info') return <InfoNotice notice={notice} L={L} />;
  if (notice.kind === 'auth_url') {
    return <AuthUrlNotice notice={notice} L={L}
      hideInstructions={notice.instructions === state.pendingPrompt?.message} />;
  }
  if (notice.kind === 'device_code') return <DeviceCodeNotice notice={notice} L={L} />;
  return (
    <div data-auth-notice="progress" data-auth-progress className="min-w-0 break-words text-state-run" role="status">
      {notice.message}
    </div>
  );
}

const PROMPT_CONTROL_CLASS =
  'box-border min-h-11 w-full rounded-card border border-proto-line-3 ' +
  'bg-surface-canvas-alt px-2g py-1.5g text-ui text-state-ink shadow-sm ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40';

function PromptSelect({ state, value, onChange }: {
  state: LoginFlowState; value: string; onChange: (value: string) => void;
}) {
  const options = (state.pendingPrompt?.options ?? []).map(option => ({
    value: option.id, label: option.label, description: option.description,
  }));
  return (
    <AuthSelect field="secret" ariaLabelledBy="auth-login-prompt-label"
      value={value} options={options} onValueChange={onChange}
      className={PROMPT_CONTROL_CLASS} />
  );
}

function PromptControl({ state, value, onChange }: {
  state: LoginFlowState; value: string; onChange: (value: string) => void;
}) {
  const L = useVocab();
  const prompt = state.pendingPrompt;
  if (!prompt) return null;
  if (prompt.kind === 'select') {
    return <PromptSelect state={state} value={value} onChange={onChange} />;
  }
  const manual = prompt.kind === 'manual_code';
  return (
    <input data-auth-secret aria-labelledby="auth-login-prompt-label"
      type={prompt.kind === 'secret' ? 'password' : 'text'} value={value}
      autoComplete={manual ? 'one-time-code' : 'off'}
      placeholder={manual ? L.authLoginCodePlaceholder : undefined}
      onChange={event => onChange(event.target.value)} className={PROMPT_CONTROL_CLASS} />
  );
}

function SelectionBody({ controller }: { controller: LoginController }) {
  const L = useVocab();
  return (
    <div className="space-y-2g">
      <label className="block space-y-1g text-ui">
        <span>{L.authLoginBackend}</span>
        <AuthSelect
          field="backend"
          ariaLabel={L.authLoginBackend}
          value={controller.backend}
          options={[
            { value: 'claude', label: 'Claude Code' },
            { value: 'pi', label: 'PI' },
          ]}
          onValueChange={controller.chooseBackend}
          className="w-full rounded-card border border-card bg-surface-card px-2g py-1g"
        />
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
      <AuthSelect
        field="type"
        ariaLabel={L.authLoginType}
        value={controller.authType}
        options={controller.authTypes.map(authType => ({
          value: authType,
          label: authType === 'api_key'
            ? L.authLoginApiKey
            : controller.backend === 'claude' ? L.authLoginSubscription : L.authLoginOAuth,
        }))}
        onValueChange={controller.chooseAuthType}
        className="w-full rounded-card border border-card bg-surface-card px-2g py-1g"
      />
    </label>
  );
}

function ProviderSelect({ controller }: { controller: LoginController }) {
  const L = useVocab();
  return (
    <label className="block space-y-1g text-ui">
      <span>{L.authLoginProvider}</span>
      <AuthSelect
        field="provider"
        ariaLabel={L.authLoginProvider}
        value={controller.provider}
        options={controller.providers.map(option => ({
          value: option.provider,
          label: option.label,
        }))}
        onValueChange={controller.chooseProvider}
        className="w-full rounded-card border border-card bg-surface-card px-2g py-1g"
      />
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

function selectedProviderLabel(
  accounts: AuthAccountStatus[],
  providers: ProviderOption[],
  backend: 'claude' | 'pi',
  provider: string,
): string {
  if (backend === 'claude') {
    return accounts.find(account => (
      account.backend === 'claude' && account.provider === provider
    ))?.label ?? provider;
  }
  return providers.find(option => option.provider === provider)?.label ?? provider;
}

function useTargetSelection(
  open: boolean,
  target: LoginFlowTarget | null | undefined,
  setBackend: Setter<'claude' | 'pi'>,
  setProvider: Setter<string>,
  setAuthType: Setter<AuthType>,
): void {
  useEffect(() => {
    if (!open || !target) return;
    setBackend(target.backend);
    setProvider(target.provider);
    setAuthType(target.authType);
  }, [open, target, setBackend, setProvider, setAuthType]);
}

function useAvailableSelection(
  backend: 'claude' | 'pi',
  provider: string,
  providers: ProviderOption[],
  authType: AuthType,
  authTypes: AuthType[],
  setProvider: Setter<string>,
  setAuthType: Setter<AuthType>,
): void {
  useEffect(() => {
    if (backend === 'pi' && providers.length > 0
      && !providers.some(option => option.provider === provider)) {
      setProvider(providers[0]?.provider ?? '');
    }
  }, [backend, provider, providers, setProvider]);
  useEffect(() => {
    if (!authTypes.includes(authType) && authTypes[0]) setAuthType(authTypes[0]);
  }, [authType, authTypes, setAuthType]);
}

function useLoginSelection(open: boolean, target?: LoginFlowTarget | null) {
  const trpc = useTRPC();
  const [backend, setBackend] = useState<'claude' | 'pi'>('claude');
  const [authType, setAuthType] = useState<AuthType>('api_key');
  const [provider, setProvider] = useState('anthropic');
  const status = useQuery({ ...trpc.auth.status.queryOptions({}), enabled: open });
  const accounts = status.data?.accounts ?? [];
  const providers = useMemo(() => piProviderOptions(accounts), [accounts]);
  const authTypes = selectedAuthTypes(accounts, providers, backend, provider);
  const providerLabel = selectedProviderLabel(accounts, providers, backend, provider);
  const backendLabel = backend === 'claude' ? 'Claude Code' : 'PI';
  useTargetSelection(open, target, setBackend, setProvider, setAuthType);
  useAvailableSelection(
    backend, provider, providers, authType, authTypes, setProvider, setAuthType,
  );
  const chooseBackend = (next: 'claude' | 'pi') => {
    setBackend(next);
    setProvider(next === 'claude' ? 'anthropic' : (providers[0]?.provider ?? ''));
  };
  return { backend, backendLabel, authType, authTypes, provider, providerLabel,
    providers, chooseBackend, chooseProvider: setProvider, chooseAuthType: setAuthType,
    ...(target ? { noticeId: target.noticeId } : {}) };
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

function errorMessage(
  reason: unknown,
  expiredMessage: string,
  conflictMessage: string,
): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message === 'Login flow not found or expired.') return expiredMessage;
  return message.includes('active on another surface') ? conflictMessage : message;
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
  expiredMessage: string;
  conflictMessage: string;
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
      ...(input.selection.noticeId ? { noticeId: input.selection.noticeId } : {}),
    });
    if (!isCurrent(input, request)) return;
    input.setFlowId(state.flowId); input.setLatest(state); input.setResponse('');
  } catch (reason) {
    if (isCurrent(input, request)) {
      input.setError(errorMessage(reason, input.expiredMessage, input.conflictMessage));
    }
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
    if (isCurrent(input, request)) {
      input.setError(errorMessage(reason, input.expiredMessage, input.conflictMessage));
    }
  }
}

async function cancelLogin(client: LoginClient, input: LoginActionState): Promise<void> {
  if (!input.flowId) return;
  const request = ++input.generation.current;
  try {
    const state = await client.auth.cancelFlow.mutate({ flowId: input.flowId });
    if (isCurrent(input, request)) input.setLatest(state);
  } catch (reason) {
    if (isCurrent(input, request)) {
      input.setError(errorMessage(reason, input.expiredMessage, input.conflictMessage));
    }
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

function selectionMatchesTarget(
  selection: ReturnType<typeof useLoginSelection>,
  target: LoginFlowTarget,
): boolean {
  return selection.backend === target.backend
    && selection.provider === target.provider
    && selection.authType === target.authType;
}

interface LoginResetState {
  generation: { current: number };
  autoStarted: { current: string | null };
  setFlowId: Setter<string | null>;
  setLatest: Setter<LoginFlowState | null>;
  setResponse: Setter<string>;
  setResponseSent: Setter<boolean>;
  setError: Setter<string | null>;
}

function targetKey(target: LoginFlowTarget): string {
  return target.noticeId ?? `settings:${target.backend}:${target.provider}:${target.authType}`;
}

function useLoginReset(
  open: boolean,
  target: LoginFlowTarget | null | undefined,
  initialState: LoginFlowState | null | undefined,
  state: LoginResetState,
): void {
  useEffect(() => {
    state.generation.current += 1;
    state.setFlowId(open && initialState ? initialState.flowId : null);
    state.setLatest(open ? initialState ?? null : null);
    state.setResponse(''); state.setResponseSent(false); state.setError(null);
    state.autoStarted.current = initialState && target ? targetKey(target) : null;
  }, [open, target, initialState]);
}

function useNoticeAutoStart(
  open: boolean,
  target: LoginFlowTarget | null | undefined,
  initialState: LoginFlowState | null | undefined,
  controller: Pick<LoginController, 'canStart' | 'start'>,
  matches: boolean,
  autoStarted: { current: string | null },
): void {
  useEffect(() => {
    if (!open || !target?.noticeId || initialState || !controller.canStart || !matches) return;
    const key = targetKey(target);
    if (autoStarted.current === key) return;
    autoStarted.current = key;
    void controller.start();
  }, [open, target, initialState, controller.canStart, controller.start, matches, autoStarted]);
}

function useLoginController(
  open: boolean,
  target?: LoginFlowTarget | null,
  initialState?: LoginFlowState | null,
  onFlowStateChange?: (state: LoginFlowState) => void,
): LoginController {
  const L = useVocab();
  const selection = useLoginSelection(open, target);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [latest, setLatest] = useState<LoginFlowState | null>(null);
  const [response, setResponse] = useState('');
  const [responseSent, setResponseSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const autoStarted = useRef<string | null>(null);
  useFlowData(open, flowId, latest, responseSent, setLatest);
  const actions = useLoginActions({ selection, flowId, response, generation,
    setFlowId, setLatest, setResponse, setResponseSent, setError,
    expiredMessage: L.authLoginExpired,
    conflictMessage: L.authLoginAlreadyActive });
  const canStart = !!selection.provider && selection.authTypes.includes(selection.authType);
  useLoginReset(open, target, initialState, { generation, autoStarted,
    setFlowId, setLatest, setResponse, setResponseSent, setError });
  useNoticeAutoStart(open, target, initialState, { canStart, start: actions.start },
    !!target && selectionMatchesTarget(selection, target), autoStarted);
  useEffect(() => { if (latest) onFlowStateChange?.(latest); }, [latest, onFlowStateChange]);
  return { ...selection, latest, response, error, canCancel: !responseSent,
    canStart, setResponse, ...actions };
}

function FlowError({ children }: { children: string }) {
  return (
    <p data-auth-error role="alert"
      className="max-h-48 min-w-0 overflow-y-auto break-words rounded-card border border-state-fail/20 bg-pill-failed-bg p-1.5g text-state-fail [overflow-wrap:anywhere]">
      {children}
    </p>
  );
}

function PromptSection({ controller, vm, L }: {
  controller: LoginController;
  vm: LoginFlowVm;
  L: Vocab;
}) {
  const state = controller.latest!;
  const stepped = state.notice?.kind === 'auth_url';
  const copy = stepped ? L.authLoginCodeStep : vm.message;
  return (
    <section data-auth-code-step className={stepped ? OAUTH_STEP_CLASS : 'min-w-0'}>
      <div className="flex min-w-0 items-start gap-1.5g">
        {stepped ? <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-state-run text-caption font-semibold text-surface-card">2</span> : null}
        <label className="min-w-0 flex-1 space-y-1g">
          <span id="auth-login-prompt-label" data-auth-prompt-copy
            className="block break-words font-medium text-state-ink">{copy}</span>
          <PromptControl state={state} value={controller.response}
            onChange={controller.setResponse} />
        </label>
      </div>
    </section>
  );
}

function LoginBody({ controller, vm, L }: {
  controller: LoginController;
  vm: LoginFlowVm;
  L: Vocab;
}): JSX.Element {
  if (vm.kind === 'selection') {
    return <div className="min-w-0 space-y-2g"><SelectionBody controller={controller} />
      {controller.error ? <FlowError>{controller.error}</FlowError> : null}</div>;
  }
  const latest = controller.latest;
  const content: Record<Exclude<LoginFlowVm['kind'], 'selection'>, ReactNode> = {
    prompt: latest ? <><NoticeBody state={latest} />
      <PromptSection controller={controller} vm={vm} L={L} /></> : null,
    notice: latest ? <NoticeBody state={latest} /> : null,
    running: <p role="status" className="break-words text-state-run">{vm.message}</p>,
    done: <p data-auth-success role="status"
      className="rounded-card bg-pill-done-bg p-2g font-medium text-state-done">{vm.message}</p>,
    failed: <FlowError>{vm.message}</FlowError>,
    cancelled: <p className="break-words text-state-muted">{vm.message}</p>,
  };
  return <div className="min-w-0 space-y-2g overflow-x-hidden"
    data-auth-flow-step={vm.kind}>
    {controller.error ? <FlowError>{controller.error}</FlowError> : null}
    {content[vm.kind]}
  </div>;
}

function loginFooter(
  controller: LoginController,
  vm: LoginFlowVm,
  onClose: () => void,
  L: Vocab,
): ReactNode {
  const cancel = controller.canCancel
    ? <Button data-action="auth-cancel" onClick={controller.cancel}>{L.cancel}</Button>
    : null;
  const close = <Button data-action="auth-close" onClick={onClose}>{L.authLoginClose}</Button>;
  const footer: Record<LoginFlowVm['kind'], ReactNode> = {
    selection: <Button data-action="auth-start" variant="primary"
      disabled={!controller.canStart} onClick={controller.start}>{L.authLoginStart}</Button>,
    prompt: <>{cancel}<Button data-action="auth-submit" variant="primary"
      disabled={!controller.response} onClick={controller.submit}>{L.authLoginSubmit}</Button></>,
    running: cancel, notice: cancel,
    done: close, failed: close, cancelled: close,
  };
  return footer[vm.kind];
}

function flowTitle(controller: LoginController): string {
  return controller.providerLabel
    ? `${controller.backendLabel} · ${controller.providerLabel}`
    : controller.backendLabel;
}

function flowDescription(controller: LoginController, vm: LoginFlowVm, L: Vocab): string {
  return vm.kind === 'prompt' && controller.latest?.notice?.kind === 'auth_url'
    ? L.authLoginAuthorizationSequence
    : vm.message;
}

function MobileLoginSheet({
  open, title, description, closeLabel, body, footer, onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  closeLabel: string;
  body: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <MBottomSheet onClose={onClose}>
      <section data-auth-sheet role="dialog" aria-modal="true"
        aria-labelledby="auth-sheet-title" aria-describedby="auth-sheet-description"
        className="flex max-h-[78dvh] min-h-[18rem] min-w-0 flex-col">
        <p id="auth-sheet-description" className="sr-only">{description}</p>
        <header className="flex flex-none items-center justify-between gap-2g pb-2g">
          <h2 id="auth-sheet-title" className="min-w-0 break-words text-body font-semibold text-state-ink">{title}</h2>
          <button type="button" aria-label={closeLabel} onClick={onClose}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-surface-card text-state-ink/70">✕</button>
        </header>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-2g">{body}</div>
        {footer ? <footer className="flex flex-none flex-wrap gap-1g border-t border-card pt-2g [&>*]:flex-1">{footer}</footer> : null}
      </section>
    </MBottomSheet>
  );
}

export function LoginFlowModal({
  open, onClose, target, initialState, onFlowStateChange,
}: LoginFlowModalProps) {
  const L = useVocab();
  const isMobile = useIsMobile();
  const controller = useLoginController(open, target, initialState, onFlowStateChange);
  const vm = buildLoginFlowVm(controller.latest, L);
  const title = flowTitle(controller);
  const description = flowDescription(controller, vm, L);
  const body = <LoginBody controller={controller} vm={vm} L={L} />;
  const footer = loginFooter(controller, vm, onClose, L);
  if (isMobile) {
    return <MobileLoginSheet open={open} title={title} description={description}
      closeLabel={L.authLoginClose} body={body} footer={footer} onClose={onClose} />;
  }
  return (
    <Modal open={open} onOpenChange={next => { if (!next) onClose(); }}
      title={title} description={description} hideDescription footer={footer}>
      {body}
    </Modal>
  );
}
