// input:  auth status/LoginFlow services, command router, platform forms
// output: Validated chat auth prompts, notices, and expiry results
// pos:    Chat authentication entry, notice, and prompt coordinator
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
  type AuthType,
  type LoginFlowNotice,
  type LoginFlowState,
} from '@domain/auth/index.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import type {
  ActionContext,
  Destination,
  MessageContent,
  MessageRef,
  ModalDefinition,
  ModalField,
  ModalSubmitContext,
  PlatformAdapter,
  RichBlock,
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
  authType?: AuthType;
  flowId?: string;
  channel: string;
  stage: 'provider' | 'auth_type' | 'prompt';
  allowedProviders?: string[];
  providerCapabilities?: Record<string, AuthType[]>;
  allowedAuthTypes?: AuthType[];
}

type LoginRequest =
  | { kind: 'status' }
  | { kind: 'login'; backend: 'claude' | 'pi'; provider?: string }
  | { kind: 'usage' };

interface NoticeTracker {
  lastNotice: string | null;
  progressRef: MessageRef | null;
}

function parseClaudeRequest(args: string[]): LoginRequest {
  return args.length === 0 ? { kind: 'login', backend: 'claude' } : { kind: 'usage' };
}

function parsePiRequest(args: string[]): LoginRequest {
  if (args.length === 0) return { kind: 'login', backend: 'pi' };
  if (args.length === 1) return { kind: 'login', backend: 'pi', provider: args[0] };
  return { kind: 'usage' };
}

function parseRequest(message: string): LoginRequest {
  const args = message.trim().split(/\s+/).slice(1);
  if (args.length === 0 || (args.length === 1 && args[0] === 'status')) return { kind: 'status' };
  if (args[0] === 'cc') return parseClaudeRequest(args.slice(1));
  if (args[0] === 'pi') return parsePiRequest(args.slice(1));
  return { kind: 'usage' };
}

function loginProviders(snapshot: AuthStatusSnapshot) {
  return snapshot.accounts.filter(account => account.backend === 'pi');
}

function loginAccount(
  snapshot: AuthStatusSnapshot,
  backend: 'claude' | 'pi',
  provider: string,
) {
  return snapshot.accounts.find(account => (
    account.backend === backend && account.provider === provider
  ));
}

function authTypeLabel(authType: AuthType): string {
  return t(`cmd.auth.type.${authType}`);
}

function loginDestination(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
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
  return [promptField(state!)];
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
  return state.step === 'prompt' || TERMINAL_STEPS.has(state.step);
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
      provider: state.outcome?.provider ?? state.provider ?? '',
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

function section(text: string): RichBlock {
  return { type: 'section', text, format: 'markdown' };
}

function messageContent(lines: string[], richBlocks?: RichBlock[]): MessageContent {
  const text = lines.join('\n');
  return { text, richBlocks: richBlocks ?? [section(text)] };
}

function renderInfoNotice(notice: Extract<LoginFlowNotice, { kind: 'info' }>): MessageContent {
  const links = (notice.links ?? []).map(link => (
    link.label ? `${link.label}: ${link.url}` : link.url
  ));
  return messageContent([notice.message, ...links]);
}

function renderAuthUrlNotice(
  notice: Extract<LoginFlowNotice, { kind: 'auth_url' }>,
): MessageContent {
  const heading = notice.instructions ?? t('cmd.auth.loginOpenAuthorization');
  return messageContent([heading, notice.url]);
}

function renderDeviceNotice(
  notice: Extract<LoginFlowNotice, { kind: 'device_code' }>,
): MessageContent {
  const code = `*${t('cmd.auth.loginDeviceCode')}*\n\`${notice.userCode}\``;
  const verify = `*${t('cmd.auth.loginVerificationPage')}*\n${notice.verificationUri}`;
  const expiry = notice.expiresInSeconds === undefined
    ? []
    : [t('cmd.auth.loginDeviceExpires', { seconds: notice.expiresInSeconds })];
  return messageContent([code, verify, ...expiry], [section(code), section(verify), ...expiry.map(section)]);
}

function renderProgressNotice(
  notice: Extract<LoginFlowNotice, { kind: 'progress' }>,
): MessageContent {
  return messageContent([t('cmd.auth.loginProgress', { message: notice.message })]);
}

function renderNotice(notice: LoginFlowNotice): MessageContent {
  if (notice.kind === 'info') return renderInfoNotice(notice);
  if (notice.kind === 'auth_url') return renderAuthUrlNotice(notice);
  if (notice.kind === 'device_code') return renderDeviceNotice(notice);
  return renderProgressNotice(notice);
}

function noticeKey(notice: LoginFlowNotice | null): string | null {
  return notice ? JSON.stringify(notice) : null;
}

async function deliverNotice(
  adapter: PlatformAdapter,
  channel: string,
  notice: LoginFlowNotice,
  tracker: NoticeTracker,
): Promise<void> {
  const key = noticeKey(notice);
  if (tracker.lastNotice === key) return;
  tracker.lastNotice = key;
  const content = renderNotice(notice);
  if (notice.kind === 'progress' && tracker.progressRef) {
    await adapter.updateMessage(tracker.progressRef, content);
    return;
  }
  const ref = await adapter.postMessage(loginDestination(channel), content);
  if (notice.kind === 'progress') tracker.progressRef = ref;
}

function promptButtonText(state: LoginFlowState): string {
  const kind = state.pendingPrompt?.kind;
  if (kind === 'manual_code') return t('cmd.auth.loginEnterCode');
  if (kind === 'select') return t('cmd.auth.loginChoose');
  return t('cmd.auth.loginContinue');
}

function openAction(metadata: LoginOpenMetadata, label: string) {
  return [{
    type: 'button' as const,
    text: label,
    actionId: 'cmd:login:open',
    value: JSON.stringify(metadata),
    style: 'primary' as const,
  }];
}

async function postPromptAction(
  adapter: PlatformAdapter,
  metadata: LoginOpenMetadata,
  state: LoginFlowState,
): Promise<void> {
  const authType = authTypeLabel(metadata.authType!);
  await adapter.postMessage(loginDestination(metadata.channel), {
    text: t('cmd.auth.loginReady', { provider: metadata.provider ?? '', authType }),
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

async function openLoginModal(
  context: ActionContext,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const metadata = JSON.parse(context.value) as LoginOpenMetadata;
  const adapter = dependencies.router.getAdapter();
  if (!adapter || metadata.channel !== context.channelId) return;
  const state = metadata.flowId ? dependencies.authLogin.getState(metadata.flowId) : null;
  if (metadata.stage === 'prompt' && (!state || !ownsFlow(state, metadata) || state.step !== 'prompt')) {
    if (state && TERMINAL_STEPS.has(state.step)) await postFlowResult(adapter, metadata.channel, state);
    else await adapter.postMessage(loginDestination(metadata.channel), { text: t('cmd.auth.loginInProgress') });
    return;
  }
  const snapshot = metadata.stage === 'provider' ? await dependencies.readStatus() : undefined;
  const modalMetadata = snapshot
    ? providerSelectionMetadata(metadata, snapshot)
    : metadata;
  await adapter.openModal(context.triggerId, buildLoginModal(
    modalMetadata, snapshot, state ?? undefined,
  ));
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
    channel: metadata.channel, sessionId: null,
  }).then(state => monitorFlow(state, { ...metadata, flowId: state.flowId }, dependencies))
    .catch(() => postBackgroundFailure(metadata, dependencies));
}

async function postAuthTypeAction(
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const adapter = dependencies.router.getAdapter();
  if (!adapter) return;
  await adapter.postMessage(loginDestination(metadata.channel), {
    text: t('cmd.auth.loginChooseAuthType', { provider: metadata.provider ?? '' }),
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
      provider: metadata.provider ?? '', authType,
    }),
    richBlocks: notice?.richBlocks,
    actions: openAction(metadata, promptButtonText(state)),
  };
}

async function startExplicitLogin(
  channel: string,
  backend: 'claude' | 'pi',
  provider: string,
  authType: AuthType,
  dependencies: ResolvedLoginDependencies,
): Promise<CommandResult> {
  const state = await dependencies.authLogin.start({
    backend, provider, authType, channel, sessionId: null,
  });
  const metadata: LoginOpenMetadata = {
    backend, provider, authType, flowId: state.flowId, channel, stage: 'prompt',
  };
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

function authTypeSelectionResult(
  channel: string,
  backend: 'claude' | 'pi',
  provider: string,
  capabilities: AuthType[],
): CommandResult {
  const metadata: LoginOpenMetadata = {
    backend, provider, channel, stage: 'auth_type', allowedAuthTypes: capabilities,
  };
  return {
    text: t('cmd.auth.loginChooseAuthType', { provider }),
    actions: openAction(metadata, t('cmd.auth.loginChoose')),
  };
}

async function startOrSelectAuthType(
  channel: string,
  backend: 'claude' | 'pi',
  provider: string,
  capabilities: AuthType[],
  dependencies: ResolvedLoginDependencies,
): Promise<CommandResult> {
  if (capabilities.length === 1) {
    return startExplicitLogin(channel, backend, provider, capabilities[0], dependencies);
  }
  return authTypeSelectionResult(channel, backend, provider, capabilities);
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
  return startOrSelectAuthType(
    channel, 'pi', selected.provider, selected.capabilities, dependencies,
  );
}

async function handleClaudeLoginRequest(
  channel: string,
  dependencies: ResolvedLoginDependencies,
): Promise<CommandResult> {
  const snapshot = await dependencies.readStatus();
  const selected = loginAccount(snapshot, 'claude', 'anthropic');
  const capabilities = selected?.capabilities ?? [];
  if (capabilities.length === 0) {
    return { text: t('cmd.auth.loginUnknownProvider', { provider: 'anthropic' }) };
  }
  return startOrSelectAuthType(channel, 'claude', 'anthropic', capabilities, dependencies);
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
    if (request.kind === 'usage') return { text: t('cmd.auth.usage') };
    if (request.backend === 'claude') return handleClaudeLoginRequest(channel, dependencies);
    return handlePiLoginRequest(channel, request, dependencies);
  };
}
