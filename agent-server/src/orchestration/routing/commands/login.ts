// input:  auth status/LoginFlow services, command router, platform forms
// output: staged chat login with validation and expiry results
// pos:    Chat authentication entry and secret-form coordinator
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { setTimeout as delay } from 'node:timers/promises';
import { t } from '@core/i18n.js';
import {
  authLoginService,
  formatAuthStatusSummary,
  LOGIN_FLOW_TTL_MS,
  getAuthStatus,
  type AuthLoginService,
  type AuthStatusSnapshot,
  type LoginFlowState,
} from '@domain/auth/index.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import type {
  ActionContext,
  Destination,
  ModalDefinition,
  ModalSubmitContext,
  PlatformAdapter,
} from '@platform/index.js';
import type { CommandResult } from './command-context.js';

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
  flowId?: string;
  channel: string;
  stage: 'provider' | 'secret';
  allowedProviders?: string[];
}

type LoginRequest =
  | { kind: 'status' }
  | { kind: 'login'; backend: 'claude' | 'pi'; provider?: string }
  | { kind: 'usage' };

function parseRequest(message: string): LoginRequest {
  const args = message.trim().split(/\s+/).slice(1);
  if (args.length === 0 || (args.length === 1 && args[0] === 'status')) return { kind: 'status' };
  if (args[0] === 'cc' && args.length === 1) return { kind: 'login', backend: 'claude' };
  if (args[0] === 'pi' && args.length <= 2) {
    return { kind: 'login', backend: 'pi', provider: args[1] };
  }
  return { kind: 'usage' };
}

function apiKeyProviders(snapshot: AuthStatusSnapshot) {
  return snapshot.accounts.filter(account => (
    account.backend === 'pi' && account.capabilities.includes('api_key')
  ));
}

function loginDestination(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

function providerField(snapshot: AuthStatusSnapshot) {
  return {
    type: 'select' as const,
    blockId: 'login_provider',
    actionId: 'selection',
    label: t('cmd.auth.loginProviderLabel'),
    placeholder: t('cmd.auth.loginProviderPlaceholder'),
    options: apiKeyProviders(snapshot).map(account => ({ label: account.label, value: account.provider })),
  };
}

function secretField() {
  return {
    type: 'text_input' as const,
    blockId: 'login_secret',
    actionId: 'value',
    label: t('cmd.auth.loginSecretLabel'),
    placeholder: t('cmd.auth.loginSecretPlaceholder'),
  };
}

function buildLoginModal(
  metadata: LoginOpenMetadata,
  snapshot?: AuthStatusSnapshot,
): ModalDefinition {
  return {
    callbackId: LOGIN_MODAL_CALLBACK,
    title: t('cmd.auth.loginModalTitle'),
    submitLabel: metadata.stage === 'provider' ? t('cmd.auth.loginContinue') : t('cmd.auth.loginSubmit'),
    closeLabel: t('cmd.auth.loginCancel'),
    privateMetadata: JSON.stringify(metadata),
    fields: metadata.stage === 'provider' ? [providerField(snapshot!)] : [secretField()],
  };
}

function stateIsActionable(state: LoginFlowState): boolean {
  return state.step === 'prompt' || TERMINAL_STEPS.has(state.step);
}

function expiredFlowState(state: LoginFlowState): LoginFlowState {
  return {
    ...state,
    step: 'failed',
    pendingPrompt: null,
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
      provider: state.outcome?.provider ?? state.provider ?? '',
      authType: state.outcome?.authType ?? state.authType ?? '',
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
    && state.provider === metadata.provider;
}

async function openLoginModal(
  context: ActionContext,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const metadata = JSON.parse(context.value) as LoginOpenMetadata;
  const adapter = dependencies.router.getAdapter();
  if (!adapter || metadata.channel !== context.channelId) return;
  if (metadata.stage === 'secret') {
    const state = metadata.flowId ? dependencies.authLogin.getState(metadata.flowId) : null;
    if (!state || !ownsFlow(state, metadata) || state.step !== 'prompt') {
      if (state && TERMINAL_STEPS.has(state.step)) await postFlowResult(adapter, metadata.channel, state);
      else await adapter.postMessage(loginDestination(metadata.channel), { text: t('cmd.auth.loginInProgress') });
      return;
    }
  }
  const snapshot = metadata.stage === 'provider' ? await dependencies.readStatus() : undefined;
  const modalMetadata = snapshot ? {
    ...metadata,
    allowedProviders: apiKeyProviders(snapshot).map(account => account.provider),
  } : metadata;
  await adapter.openModal(context.triggerId, buildLoginModal(modalMetadata, snapshot));
}

function submittedValue(context: ModalSubmitContext, blockId: string, actionId: string): string {
  return context.values?.[blockId]?.[actionId]?.value?.trim() ?? '';
}

function selectedProvider(context: ModalSubmitContext): string {
  return context.values?.login_provider?.selection?.selectedOption?.value ?? '';
}

function postBackgroundFailure(
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): void {
  const adapter = dependencies.router.getAdapter();
  if (!adapter) return;
  void adapter.postMessage(loginDestination(metadata.channel), {
    text: t('cmd.auth.loginFailed', { error: t('cmd.auth.loginUnknownFailure') }),
  });
}

async function postSecretAction(
  adapter: PlatformAdapter,
  metadata: LoginOpenMetadata,
): Promise<void> {
  await adapter.postMessage(loginDestination(metadata.channel), {
    text: t('cmd.auth.loginReady', { provider: metadata.provider ?? '' }),
    richBlocks: [{ type: 'actions', elements: openAction(metadata) }],
  });
}

async function prepareFlow(
  state: LoginFlowState,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const adapter = dependencies.router.getAdapter()!;
  const prompted = await waitForActionable(dependencies.authLogin, state);
  if (prompted.step !== 'prompt') {
    await postFlowResult(adapter, metadata.channel, prompted);
    return;
  }
  await postSecretAction(adapter, { ...metadata, flowId: prompted.flowId, stage: 'secret' });
}

function prepareFlowInBackground(
  state: LoginFlowState,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): void {
  void prepareFlow(state, metadata, dependencies)
    .catch(() => postBackgroundFailure(metadata, dependencies));
}

async function handoffLoginSecret(
  metadata: LoginOpenMetadata,
  secret: string,
  dependencies: InteractiveLoginDependencies,
): Promise<LoginFlowState> {
  const state = metadata.flowId ? dependencies.authLogin.getState(metadata.flowId) : null;
  if (!state || !ownsFlow(state, metadata) || state.step !== 'prompt') {
    throw new Error('Login flow is not waiting for a secret.');
  }
  return dependencies.authLogin.respond(state.flowId, secret);
}

async function monitorLoginSettlement(
  state: LoginFlowState,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const settled = await waitForActionable(dependencies.authLogin, state);
  await postFlowResult(dependencies.router.getAdapter()!, metadata.channel, settled);
}

function completeLoginInBackground(
  metadata: LoginOpenMetadata,
  secret: string,
  dependencies: InteractiveLoginDependencies,
): void {
  void handoffLoginSecret(metadata, secret, dependencies)
    .then(state => monitorLoginSettlement(state, metadata, dependencies))
    .catch(() => postBackgroundFailure(metadata, dependencies));
}

function startProviderFlow(
  metadata: LoginOpenMetadata,
  provider: string,
  dependencies: InteractiveLoginDependencies,
): void {
  void dependencies.authLogin.start({
    backend: 'pi', provider, authType: 'api_key', channel: metadata.channel, sessionId: null,
  }).then(state => prepareFlow(state, { ...metadata, provider }, dependencies))
    .catch(() => postBackgroundFailure(metadata, dependencies));
}

async function submitProvider(
  context: ModalSubmitContext,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const provider = selectedProvider(context);
  if (!provider || !metadata.allowedProviders?.includes(provider)) {
    const error = provider
      ? t('cmd.auth.loginUnknownProvider', { provider })
      : t('cmd.auth.loginRequired');
    await context.ack({ errors: { login_provider: error } });
    return;
  }
  await context.ack();
  startProviderFlow(metadata, provider, dependencies);
}

async function submitSecret(
  context: ModalSubmitContext,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const secret = submittedValue(context, 'login_secret', 'value');
  if (!secret) {
    await context.ack({ errors: { login_secret: t('cmd.auth.loginRequired') } });
    return;
  }
  await context.ack();
  completeLoginInBackground(metadata, secret, dependencies);
}

async function submitLoginModal(
  context: ModalSubmitContext,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const metadata = JSON.parse(context.privateMetadata) as LoginOpenMetadata;
  if (metadata.stage === 'provider') return submitProvider(context, metadata, dependencies);
  return submitSecret(context, metadata, dependencies);
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

function openAction(metadata: LoginOpenMetadata) {
  return [{
    type: 'button' as const,
    text: t('cmd.auth.loginContinue'),
    actionId: 'cmd:login:open',
    value: JSON.stringify(metadata),
    style: 'primary' as const,
  }];
}

async function startExplicitLogin(
  channel: string,
  backend: 'claude' | 'pi',
  provider: string,
  adapter: PlatformAdapter,
  dependencies: ResolvedLoginDependencies,
): Promise<CommandResult> {
  const state = await dependencies.authLogin.start({
    backend, provider, authType: 'api_key', channel, sessionId: null,
  });
  const metadata: LoginOpenMetadata = {
    backend, provider, flowId: state.flowId, channel, stage: 'secret',
  };
  if (state.step === 'prompt') {
    return { text: t('cmd.auth.loginReady', { provider }), actions: openAction(metadata) };
  }
  if (TERMINAL_STEPS.has(state.step)) return { text: flowResultText(state) };
  if (dependencies.router) {
    prepareFlowInBackground(state, metadata, { ...dependencies, router: dependencies.router });
  } else {
    void waitForActionable(dependencies.authLogin, state)
      .then(result => postFlowResult(adapter, channel, result));
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

export function createLoginHandler(input: LoginCommandDependencies = {}) {
  const dependencies = resolvedDependencies(input);
  if (dependencies.router) {
    registerLoginInteractions({ ...dependencies, router: dependencies.router });
  }
  return async function handleLoginCmd(
    channel: string,
    adapter: PlatformAdapter,
    message: string,
  ): Promise<CommandResult> {
    const request = parseRequest(message);
    if (request.kind === 'status') {
      return { text: formatAuthStatusSummary(await dependencies.readStatus()) };
    }
    if (request.kind === 'usage') return { text: t('cmd.auth.usage') };
    if (request.backend === 'claude') {
      return startExplicitLogin(channel, 'claude', 'anthropic', adapter, dependencies);
    }
    const snapshot = await dependencies.readStatus();
    const providers = apiKeyProviders(snapshot);
    if (request.provider && !providers.some(account => account.provider === request.provider)) {
      return { text: t('cmd.auth.loginUnknownProvider', { provider: request.provider }) };
    }
    if (request.provider) {
      return startExplicitLogin(channel, 'pi', request.provider, adapter, dependencies);
    }
    if (providers.length === 0) return { text: t('cmd.auth.loginNoProviders') };
    return {
      text: t('cmd.auth.loginChooseProvider'),
      actions: openAction({ backend: 'pi', channel, stage: 'provider' }),
    };
  };
}
