import { setTimeout as delay } from 'node:timers/promises';
import { t } from '@core/i18n.js';
import { createLogger } from '@core/log.js';
import {
  authLoginService,
  formatAuthStatusSummary,
  LOGIN_FLOW_TTL_MS,
  getAuthStatus,
  type AuthLoginService,
  type AuthStatusSnapshot,
  type AuthType,
  type LoginFlowNotice,
  type LoginFlowState,
} from '@domain/auth/index.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import type {
  ActionContext,
  ButtonElement,
  ModalDefinition,
  ModalField,
  ModalSubmitContext,
  PlatformAdapter,
} from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import { handleCustomProviderCommand } from './login-custom.js';
import { findNamedAccount, loginName, unknownAccountText } from './login-accounts.js';
import { deliverNotice, loginDestination, noticeKey, renderNotice, type NoticeTracker } from './login-render.js';
import {
  loginStartFailureText,
  openAuthRequiredLoginAction,
  type AuthRequiredLoginMetadata,
} from './login-notice.js';

const LOGIN_MODAL_CALLBACK = 'cmd_login_submit';
const FLOW_WAIT_MS = LOGIN_FLOW_TTL_MS;
const FLOW_POLL_MS = 25;
const TERMINAL_STEPS = new Set(['done', 'failed', 'cancelled']);

type AuthStatusReader = () => Promise<AuthStatusSnapshot>;

export interface LoginCommandDependencies {
  readStatus?: AuthStatusReader;
  authLogin?: AuthLoginService;
  router?: CommandActionRouter;
}

interface ResolvedLoginDependencies {
  readStatus: AuthStatusReader;
  authLogin: AuthLoginService;
  router?: CommandActionRouter;
}

type InteractiveLoginDependencies = ResolvedLoginDependencies & { router: CommandActionRouter };

interface LoginOpenMetadata {
  backend: 'claude' | 'pi';
  provider?: string;
  /** A named account to sign in again; absent or null is the provider's default login. */
  connection?: string | null;
  authType?: AuthType;
  flowId?: string;
  noticeId?: string;
  noticeText?: string;
  channel: string;
  stage: 'provider' | 'auth_type' | 'prompt' | 'notice';
  allowedProviders?: string[];
  providerCapabilities?: Record<string, AuthType[]>;
  allowedAuthTypes?: AuthType[];
}

type LoginRequest =
  | { kind: 'status' }
  | { kind: 'login'; backend: 'claude' | 'pi'; provider?: string; account?: string }
  | { kind: 'custom'; args: string[] }
  | { kind: 'usage' };


/** `!login cc [account]`. */
function parseClaudeRequest(args: string[]): LoginRequest {
  if (args.length > 1) return { kind: 'usage' };
  return { kind: 'login', backend: 'claude', ...(args[0] ? { account: args[0] } : {}) };
}

/** `!login pi [provider [account]]`. */
function parsePiRequest(args: string[]): LoginRequest {
  if (args.length > 2) return { kind: 'usage' };
  const [provider, account] = args;
  return { kind: 'login', backend: 'pi', ...(provider ? { provider } : {}), ...(account ? { account } : {}) };
}

function parseRequest(message: string): LoginRequest {
  const args = message.trim().split(/\s+/).slice(1);
  if (args.length === 0 || (args.length === 1 && args[0] === 'status')) return { kind: 'status' };
  if (args[0] === 'cc') return parseClaudeRequest(args.slice(1));
  if (args[0] === 'pi') return parsePiRequest(args.slice(1));
  // Custom providers have no login flow — they are defined, listed and deleted instead.
  if (args[0] === 'custom') return { kind: 'custom', args: args.slice(1) };
  return { kind: 'usage' };
}

/** PI providers to sign in to: their default logins; named accounts sit beside them. */
function loginProviders(snapshot: AuthStatusSnapshot) {
  return snapshot.accounts.filter(account => (
    account.backend === 'pi' && !account.connection && account.capabilities.length > 0
  ));
}

function loginAccount(
  snapshot: AuthStatusSnapshot,
  backend: 'claude' | 'pi',
  provider: string,
) {
  return snapshot.accounts.find(account => (
    account.backend === backend && account.provider === provider && !account.connection
  ));
}

function authTypeLabel(authType: AuthType): string {
  return t(`cmd.auth.type.${authType}`);
}


function providerField(snapshot: AuthStatusSnapshot): ModalField {
  return {
    type: 'select',
    blockId: 'login_provider',
    actionId: 'selection',
    label: t('cmd.auth.loginProviderLabel'),
    placeholder: t('cmd.auth.loginProviderPlaceholder'),
    options: loginProviders(snapshot).map(account => ({
      label: account.label,
      value: account.provider,
    })),
  };
}

function authTypeField(metadata: LoginOpenMetadata): ModalField {
  return {
    type: 'select',
    blockId: 'login_auth_type',
    actionId: 'selection',
    label: t('cmd.auth.loginAuthTypeLabel'),
    placeholder: t('cmd.auth.loginAuthTypePlaceholder'),
    options: (metadata.allowedAuthTypes ?? []).map(authType => ({
      label: authTypeLabel(authType),
      value: authType,
    })),
  };
}

function promptCopy(kind: NonNullable<LoginFlowState['pendingPrompt']>['kind']) {
  const copy = {
    text: ['cmd.auth.loginTextLabel', 'cmd.auth.loginTextPlaceholder'],
    secret: ['cmd.auth.loginSecretLabel', 'cmd.auth.loginSecretPlaceholder'],
    manual_code: ['cmd.auth.loginCodeLabel', 'cmd.auth.loginCodePlaceholder'],
  } as const;
  return kind === 'select' ? null : copy[kind];
}

function promptField(state: LoginFlowState): ModalField {
  const prompt = state.pendingPrompt!;
  if (prompt.kind === 'select') {
    return {
      type: 'select', blockId: 'login_prompt', actionId: 'selection',
      label: prompt.message, placeholder: t('cmd.auth.loginSelectPlaceholder'),
      options: (prompt.options ?? []).map(option => ({ label: option.label, value: option.id })),
    };
  }
  const copy = promptCopy(prompt.kind)!;
  return {
    type: 'text_input', blockId: 'login_secret', actionId: 'value',
    label: t(copy[0]), placeholder: t(copy[1]),
  };
}

function modalFields(
  metadata: LoginOpenMetadata,
  snapshot?: AuthStatusSnapshot,
  state?: LoginFlowState,
): ModalField[] {
  if (metadata.stage === 'provider') return [providerField(snapshot!)];
  if (metadata.stage === 'auth_type') return [authTypeField(metadata)];
  const notice = state?.notice ? renderNotice(state.notice).text : null;
  return [
    ...(notice ? [{ type: 'section' as const, text: notice }] : []),
    promptField(state!),
  ];
}

function buildLoginModal(
  metadata: LoginOpenMetadata,
  snapshot?: AuthStatusSnapshot,
  state?: LoginFlowState,
): ModalDefinition {
  return {
    callbackId: LOGIN_MODAL_CALLBACK,
    title: t('cmd.auth.loginModalTitle'),
    submitLabel: metadata.stage === 'prompt'
      ? t('cmd.auth.loginSubmit')
      : t('cmd.auth.loginChoose'),
    closeLabel: t('cmd.auth.loginCancel'),
    privateMetadata: JSON.stringify(metadata),
    fields: modalFields(metadata, snapshot, state),
  };
}

function stateIsActionable(state: LoginFlowState): boolean {
  return state.step === 'prompt' || state.notice !== null || TERMINAL_STEPS.has(state.step);
}

function expiredFlowState(state: LoginFlowState): LoginFlowState {
  return {
    ...state,
    step: 'failed',
    pendingPrompt: null,
    notice: null,
    outcome: null,
    error: t('cmd.auth.loginExpired'),
    errorCode: 'flow_expired',
  };
}

async function waitForActionable(
  service: AuthLoginService,
  initial: LoginFlowState,
): Promise<LoginFlowState> {
  if (stateIsActionable(initial)) return initial;
  const deadline = Math.min(Date.now() + FLOW_WAIT_MS, Date.parse(initial.expiresAt));
  let state = initial;
  while (Date.now() < deadline) {
    await delay(FLOW_POLL_MS);
    const current = service.getState(initial.flowId);
    if (!current) return expiredFlowState(state);
    state = current;
    if (stateIsActionable(state)) return state;
  }
  return expiredFlowState(state);
}

function flowResultText(state: LoginFlowState): string {
  if (state.step === 'done') {
    return t('cmd.auth.loginSucceeded', {
      provider: loginName(state.outcome?.provider ?? state.provider ?? '', state.connection),
      authType: authTypeLabel(state.outcome?.authType ?? state.authType ?? 'api_key'),
      expires: state.outcome?.expiresAt ?? t('cmd.auth.loginNoExpiry'),
    });
  }
  if (state.step === 'failed') {
    return t('cmd.auth.loginFailed', { error: state.error ?? t('cmd.auth.loginUnknownFailure') });
  }
  if (state.step === 'cancelled') return t('cmd.auth.loginCancelled');
  return t('cmd.auth.loginInProgress');
}

async function postFlowResult(
  adapter: PlatformAdapter,
  channel: string,
  state: LoginFlowState,
): Promise<void> {
  await adapter.postMessage(loginDestination(channel), { text: flowResultText(state) });
}

function ownsFlow(state: LoginFlowState, metadata: LoginOpenMetadata): boolean {
  return state.channel === metadata.channel
    && state.backend === metadata.backend
    && state.provider === metadata.provider
    && (state.connection ?? null) === (metadata.connection ?? null)
    && state.authType === metadata.authType;
}

function providerSelectionMetadata(
  metadata: LoginOpenMetadata,
  snapshot: AuthStatusSnapshot,
): LoginOpenMetadata {
  const providers = loginProviders(snapshot);
  return {
    ...metadata,
    allowedProviders: providers.map(account => account.provider),
    providerCapabilities: Object.fromEntries(providers.map(account => (
      [account.provider, account.capabilities]
    ))),
  };
}

function promptButtonText(state: LoginFlowState): string {
  const kind = state.pendingPrompt?.kind;
  if (kind === 'manual_code') return t('cmd.auth.loginEnterCode');
  if (kind === 'select') return t('cmd.auth.loginChoose');
  return t('cmd.auth.loginContinue');
}

function openAction(metadata: LoginOpenMetadata, label: string): ButtonElement[] {
  return [{
    type: 'button',
    text: label,
    actionId: 'cmd:login:open',
    value: JSON.stringify(metadata),
    style: 'primary',
  }];
}

async function postPromptAction(
  adapter: PlatformAdapter,
  metadata: LoginOpenMetadata,
  state: LoginFlowState,
): Promise<void> {
  const authType = authTypeLabel(metadata.authType!);
  await adapter.postMessage(loginDestination(metadata.channel), {
    text: t('cmd.auth.loginReady', { provider: loginName(metadata.provider ?? '', metadata.connection), authType }),
    richBlocks: [{
      type: 'actions',
      elements: openAction({ ...metadata, flowId: state.flowId, stage: 'prompt' }, promptButtonText(state)),
    }],
  });
}

async function handleMonitorState(
  adapter: PlatformAdapter,
  metadata: LoginOpenMetadata,
  state: LoginFlowState,
  tracker: NoticeTracker,
): Promise<'continue' | 'stop'> {
  if (state.notice) await deliverNotice(adapter, metadata.channel, state.notice, tracker);
  if (TERMINAL_STEPS.has(state.step)) {
    await postFlowResult(adapter, metadata.channel, state);
    return 'stop';
  }
  if (state.step === 'prompt') {
    await postPromptAction(adapter, metadata, state);
    return 'stop';
  }
  return 'continue';
}

async function monitorFlow(
  initial: LoginFlowState,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
  skipInitialNotice = false,
): Promise<void> {
  const adapter = dependencies.router.getAdapter()!;
  const tracker: NoticeTracker = {
    lastNotice: skipInitialNotice ? noticeKey(initial.notice) : null,
    progressRef: null,
  };
  const deadline = Math.min(Date.now() + FLOW_WAIT_MS, Date.parse(initial.expiresAt));
  let state = initial;
  while (Date.now() < deadline) {
    if (await handleMonitorState(adapter, metadata, state, tracker) === 'stop') return;
    await delay(FLOW_POLL_MS);
    const next = dependencies.authLogin.getState(initial.flowId);
    if (!next) break;
    state = next;
  }
  await postFlowResult(adapter, metadata.channel, expiredFlowState(state));
}

function monitorInBackground(
  state: LoginFlowState,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
  skipInitialNotice = false,
): void {
  void monitorFlow(state, metadata, dependencies, skipInitialNotice)
    .catch(() => postBackgroundFailure(metadata, dependencies));
}

async function presentNotificationFlow(
  context: ActionContext,
  metadata: AuthRequiredLoginMetadata,
  state: LoginFlowState,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const adapter = dependencies.router.getAdapter();
  if (!adapter) return;
  if (TERMINAL_STEPS.has(state.step)) {
    await postFlowResult(adapter, metadata.channel, state);
    return;
  }
  if (state.step !== 'prompt') {
    monitorInBackground(state, metadata, dependencies);
    return;
  }
  await adapter.openModal(context.triggerId, buildLoginModal(
    { ...metadata, stage: 'prompt' }, undefined, state,
  ));
}

async function openRequiredNotice(
  context: ActionContext,
  metadata: LoginOpenMetadata,
  adapter: PlatformAdapter,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  await openAuthRequiredLoginAction(context, metadata as AuthRequiredLoginMetadata, {
    adapter,
    authLogin: dependencies.authLogin,
    waitForActionable: state => waitForActionable(dependencies.authLogin, state),
    present: (actionContext, noticeMetadata, state) => (
      presentNotificationFlow(actionContext, noticeMetadata, state, dependencies)
    ),
  });
}

async function openStandardLogin(
  context: ActionContext,
  metadata: LoginOpenMetadata,
  adapter: PlatformAdapter,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const state = metadata.flowId ? dependencies.authLogin.getState(metadata.flowId) : null;
  if (metadata.stage === 'prompt' && (!state || !ownsFlow(state, metadata) || state.step !== 'prompt')) {
    if (state && TERMINAL_STEPS.has(state.step)) await postFlowResult(adapter, metadata.channel, state);
    else await adapter.postMessage(loginDestination(metadata.channel), { text: t('cmd.auth.loginInProgress') });
    return;
  }
  const snapshot = metadata.stage === 'provider' ? await dependencies.readStatus() : undefined;
  const modalMetadata = snapshot ? providerSelectionMetadata(metadata, snapshot) : metadata;
  await adapter.openModal(context.triggerId, buildLoginModal(
    modalMetadata, snapshot, state ?? undefined,
  ));
}

function noticeMetadataForContext(
  metadata: LoginOpenMetadata,
  context: ActionContext,
): LoginOpenMetadata | null {
  if (metadata.channel && metadata.channel !== context.channelId) return null;
  return { ...metadata, channel: context.channelId };
}

async function openLoginModal(
  context: ActionContext,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const metadata = JSON.parse(context.value) as LoginOpenMetadata;
  const adapter = dependencies.router.getAdapter();
  if (!adapter) return;
  if (metadata.stage === 'notice') {
    const resolved = noticeMetadataForContext(metadata, context);
    if (resolved) await openRequiredNotice(context, resolved, adapter, dependencies);
    return;
  }
  if (metadata.channel !== context.channelId) return;
  await openStandardLogin(context, metadata, adapter, dependencies);
}

function submittedValue(context: ModalSubmitContext, blockId: string, actionId: string): string {
  return context.values?.[blockId]?.[actionId]?.value?.trim() ?? '';
}

function selectedValue(context: ModalSubmitContext, blockId: string): string {
  return context.values?.[blockId]?.selection?.selectedOption?.value ?? '';
}

function submittedPromptValue(context: ModalSubmitContext): string {
  return selectedValue(context, 'login_prompt')
    || submittedValue(context, 'login_secret', 'value');
}

const log = createLogger('login');

function postBackgroundFailure(
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
  error?: unknown,
): void {
  const adapter = dependencies.router.getAdapter();
  if (!adapter) return;
  void adapter.postMessage(loginDestination(metadata.channel), {
    text: t('cmd.auth.loginFailed', { error: loginStartFailureText(error) }),
  }).catch((e) => log.warn('login failure notice could not be posted:', (e as Error).message));
}

async function handoffLoginPrompt(
  metadata: LoginOpenMetadata,
  value: string,
  dependencies: InteractiveLoginDependencies,
): Promise<LoginFlowState> {
  const state = metadata.flowId ? dependencies.authLogin.getState(metadata.flowId) : null;
  if (!state || !ownsFlow(state, metadata) || state.step !== 'prompt') {
    throw new Error('Login flow is not waiting for a prompt response.');
  }
  return dependencies.authLogin.respond(state.flowId, value);
}

function completeLoginInBackground(
  metadata: LoginOpenMetadata,
  value: string,
  dependencies: InteractiveLoginDependencies,
): void {
  void handoffLoginPrompt(metadata, value, dependencies)
    .then(state => monitorFlow(state, metadata, dependencies, true))
    .catch(() => postBackgroundFailure(metadata, dependencies));
}

function startSelectedFlow(
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): void {
  void dependencies.authLogin.start({
    backend: metadata.backend, provider: metadata.provider!, authType: metadata.authType!,
    ...(metadata.connection ? { connection: metadata.connection } : {}),
    channel: metadata.channel, sessionId: null,
  }).then(state => monitorFlow(state, { ...metadata, flowId: state.flowId }, dependencies))
    .catch(error => postBackgroundFailure(metadata, dependencies, error));
}

async function postAuthTypeAction(
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const adapter = dependencies.router.getAdapter();
  if (!adapter) return;
  await adapter.postMessage(loginDestination(metadata.channel), {
    text: t('cmd.auth.loginChooseAuthType', { provider: loginName(metadata.provider ?? '', metadata.connection) }),
    richBlocks: [{
      type: 'actions',
      elements: openAction(metadata, t('cmd.auth.loginChoose')),
    }],
  });
}

async function submitProvider(
  context: ModalSubmitContext,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const provider = selectedValue(context, 'login_provider');
  const capabilities = metadata.providerCapabilities?.[provider] ?? [];
  if (!provider || !metadata.allowedProviders?.includes(provider) || capabilities.length === 0) {
    const error = provider
      ? t('cmd.auth.loginUnknownProvider', { provider })
      : t('cmd.auth.loginRequired');
    await context.ack({ errors: { login_provider: error } });
    return;
  }
  await context.ack();
  const selection = { ...metadata, provider, allowedAuthTypes: capabilities };
  if (capabilities.length === 1) {
    startSelectedFlow({ ...selection, authType: capabilities[0], stage: 'prompt' }, dependencies);
    return;
  }
  await postAuthTypeAction({ ...selection, stage: 'auth_type' }, dependencies);
}

async function submitAuthType(
  context: ModalSubmitContext,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const authType = selectedValue(context, 'login_auth_type') as AuthType;
  if (!metadata.allowedAuthTypes?.includes(authType)) {
    await context.ack({ errors: { login_auth_type: t('cmd.auth.loginRequired') } });
    return;
  }
  await context.ack();
  startSelectedFlow({ ...metadata, authType, stage: 'prompt' }, dependencies);
}

async function submitPrompt(
  context: ModalSubmitContext,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const value = submittedPromptValue(context);
  if (!value) {
    await context.ack({ errors: { login_secret: t('cmd.auth.loginRequired') } });
    return;
  }
  await context.ack();
  completeLoginInBackground(metadata, value, dependencies);
}

async function submitLoginModal(
  context: ModalSubmitContext,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const metadata = JSON.parse(context.privateMetadata) as LoginOpenMetadata;
  if (metadata.stage === 'provider') return submitProvider(context, metadata, dependencies);
  if (metadata.stage === 'auth_type') return submitAuthType(context, metadata, dependencies);
  return submitPrompt(context, metadata, dependencies);
}

function handleLoginAction(
  context: ActionContext,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  if (!context.channelId.startsWith('feishu:')) return openLoginModal(context, dependencies);
  const metadata = JSON.parse(context.value) as LoginOpenMetadata;
  void openLoginModal(context, dependencies)
    .catch(() => postBackgroundFailure(metadata, dependencies));
  return Promise.resolve();
}

function registerLoginInteractions(dependencies: InteractiveLoginDependencies): void {
  dependencies.router.registerCommand('login', {
    actions: [{
      actionId: 'open',
      handler: context => handleLoginAction(context, dependencies),
    }],
    modals: [{
      callbackId: LOGIN_MODAL_CALLBACK,
      handler: context => submitLoginModal(context, dependencies),
    }],
  });
}

function promptResult(state: LoginFlowState, metadata: LoginOpenMetadata): CommandResult {
  const notice = state.notice ? renderNotice(state.notice) : null;
  const authType = authTypeLabel(metadata.authType!);
  return {
    text: notice?.text ?? t('cmd.auth.loginReady', {
      provider: loginName(metadata.provider ?? '', metadata.connection), authType,
    }),
    richBlocks: notice?.richBlocks,
    actions: openAction(metadata, promptButtonText(state)),
  };
}

/** Where an explicit login goes: the channel it reports to and the login it signs in. */
interface LoginTarget {
  channel: string;
  backend: 'claude' | 'pi';
  provider: string;
  connection: string | null;
}

function targetMetadata(target: LoginTarget): Pick<LoginOpenMetadata, 'backend' | 'provider' | 'channel' | 'connection'> {
  return {
    backend: target.backend, provider: target.provider, channel: target.channel,
    ...(target.connection ? { connection: target.connection } : {}),
  };
}

async function startExplicitLogin(
  target: LoginTarget,
  authType: AuthType,
  dependencies: ResolvedLoginDependencies,
): Promise<CommandResult> {
  const state = await dependencies.authLogin.start({
    backend: target.backend, provider: target.provider, authType,
    ...(target.connection ? { connection: target.connection } : {}),
    channel: target.channel, sessionId: null,
  });
  const metadata: LoginOpenMetadata = { ...targetMetadata(target), authType, flowId: state.flowId, stage: 'prompt' };
  if (state.step === 'prompt') return promptResult(state, metadata);
  if (TERMINAL_STEPS.has(state.step)) return { text: flowResultText(state) };
  if (dependencies.router) {
    monitorInBackground(state, metadata, { ...dependencies, router: dependencies.router });
  }
  return { text: t('cmd.auth.loginInProgress') };
}

function resolvedDependencies(input: LoginCommandDependencies): ResolvedLoginDependencies {
  return {
    readStatus: input.readStatus ?? getAuthStatus,
    authLogin: input.authLogin ?? authLoginService,
    router: input.router,
  };
}

function providerSelectionResult(channel: string, count: number): CommandResult {
  if (count === 0) return { text: t('cmd.auth.loginNoProviders') };
  const metadata: LoginOpenMetadata = { backend: 'pi', channel, stage: 'provider' };
  return {
    text: t('cmd.auth.loginChooseProvider'),
    actions: openAction(metadata, t('cmd.auth.loginChoose')),
  };
}

function authTypeSelectionResult(target: LoginTarget, capabilities: AuthType[]): CommandResult {
  const metadata: LoginOpenMetadata = { ...targetMetadata(target), stage: 'auth_type', allowedAuthTypes: capabilities };
  return {
    text: t('cmd.auth.loginChooseAuthType', { provider: loginName(target.provider, target.connection) }),
    actions: openAction(metadata, t('cmd.auth.loginChoose')),
  };
}

async function startOrSelectAuthType(
  target: LoginTarget,
  capabilities: AuthType[],
  dependencies: ResolvedLoginDependencies,
): Promise<CommandResult> {
  if (capabilities.length === 1) return startExplicitLogin(target, capabilities[0], dependencies);
  return authTypeSelectionResult(target, capabilities);
}

/** `!login cc <account>` / `!login pi <provider> <account>`: sign an existing account in again. */
function startAccountLogin(
  target: Omit<LoginTarget, 'connection'>,
  snapshot: AuthStatusSnapshot,
  name: string,
  dependencies: ResolvedLoginDependencies,
): Promise<CommandResult> | CommandResult {
  const account = findNamedAccount(snapshot, target.backend, target.provider, name);
  if (!account) return { text: unknownAccountText(snapshot, target.backend, target.provider, name) };
  return startOrSelectAuthType({ ...target, connection: account.connection }, account.capabilities, dependencies);
}

async function handlePiLoginRequest(
  channel: string,
  request: Extract<LoginRequest, { kind: 'login' }>,
  dependencies: ResolvedLoginDependencies,
): Promise<CommandResult> {
  const snapshot = await dependencies.readStatus();
  const providers = loginProviders(snapshot);
  if (!request.provider) return providerSelectionResult(channel, providers.length);
  const selected = loginAccount(snapshot, 'pi', request.provider);
  if (!selected || selected.capabilities.length === 0) {
    return { text: t('cmd.auth.loginUnknownProvider', { provider: request.provider }) };
  }
  const target = { channel, backend: 'pi' as const, provider: selected.provider };
  if (request.account) return startAccountLogin(target, snapshot, request.account, dependencies);
  return startOrSelectAuthType({ ...target, connection: null }, selected.capabilities, dependencies);
}

async function handleClaudeLoginRequest(
  channel: string,
  request: Extract<LoginRequest, { kind: 'login' }>,
  dependencies: ResolvedLoginDependencies,
): Promise<CommandResult> {
  const snapshot = await dependencies.readStatus();
  const target = { channel, backend: 'claude' as const, provider: 'anthropic' };
  if (request.account) return startAccountLogin(target, snapshot, request.account, dependencies);
  const capabilities = loginAccount(snapshot, 'claude', 'anthropic')?.capabilities ?? [];
  if (capabilities.length === 0) {
    return { text: t('cmd.auth.loginUnknownProvider', { provider: 'anthropic' }) };
  }
  return startOrSelectAuthType({ ...target, connection: null }, capabilities, dependencies);
}

export function createLoginHandler(input: LoginCommandDependencies = {}) {
  const dependencies = resolvedDependencies(input);
  if (dependencies.router) registerLoginInteractions({ ...dependencies, router: dependencies.router });
  return async function handleLoginCmd(
    channel: string,
    _adapter: PlatformAdapter,
    message: string,
  ): Promise<CommandResult> {
    const request = parseRequest(message);
    if (request.kind === 'status') {
      return { text: formatAuthStatusSummary(await dependencies.readStatus()) };
    }
    if (request.kind === 'custom') {
      return handleCustomProviderCommand(request.args);
    }
    if (request.kind === 'usage') return { text: t('cmd.auth.usage') };
    if (request.backend === 'claude') return handleClaudeLoginRequest(channel, request, dependencies);
    return handlePiLoginRequest(channel, request, dependencies);
  };
}
