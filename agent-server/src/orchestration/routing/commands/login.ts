// input:  auth status/LoginFlow services, command router, platform forms
// output: !login status and staged Slack/Feishu login handlers
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
  authType: AuthType;
  flowId?: string;
  channel: string;
  stage: 'provider' | 'prompt';
}

type LoginRequest =
  | { kind: 'status' }
  | { kind: 'login'; backend: 'claude' | 'pi'; authType: AuthType; provider?: string }
  | { kind: 'usage' };

interface NoticeTracker {
  lastNotice: string | null;
  progressRef: MessageRef | null;
}

function parseAuthType(value: string | undefined): AuthType | null {
  if (value === 'api_key' || value === 'oauth') return value;
  return null;
}

function parseClaudeRequest(args: string[]): LoginRequest {
  if (args.length === 0) return { kind: 'login', backend: 'claude', authType: 'api_key' };
  const authType = parseAuthType(args[0]);
  if (args.length === 1 && authType) return { kind: 'login', backend: 'claude', authType };
  return { kind: 'usage' };
}

function parsePiRequest(args: string[]): LoginRequest {
  if (args.length === 0) return { kind: 'login', backend: 'pi', authType: 'api_key' };
  const explicitType = parseAuthType(args[0]);
  if (explicitType && args.length <= 2) {
    return { kind: 'login', backend: 'pi', authType: explicitType, provider: args[1] };
  }
  if (args.length === 1) {
    return { kind: 'login', backend: 'pi', authType: 'api_key', provider: args[0] };
  }
  return { kind: 'usage' };
}

function parseRequest(message: string): LoginRequest {
  const args = message.trim().split(/\s+/).slice(1);
  if (args.length === 0 || (args.length === 1 && args[0] === 'status')) return { kind: 'status' };
  if (args[0] === 'cc') return parseClaudeRequest(args.slice(1));
  if (args[0] === 'pi') return parsePiRequest(args.slice(1));
  return { kind: 'usage' };
}

function loginProviders(snapshot: AuthStatusSnapshot, authType: AuthType) {
  return snapshot.accounts.filter(account => (
    account.backend === 'pi' && account.capabilities.includes(authType)
  ));
}

function authTypeLabel(authType: AuthType): string {
  return t(`cmd.auth.type.${authType}`);
}

function loginDestination(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

function providerField(snapshot: AuthStatusSnapshot, authType: AuthType): ModalField {
  return {
    type: 'select',
    blockId: 'login_provider',
    actionId: 'selection',
    label: t('cmd.auth.loginProviderLabel'),
    placeholder: t('cmd.auth.loginProviderPlaceholder'),
    options: loginProviders(snapshot, authType).map(account => ({
      label: account.label,
      value: account.provider,
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

function buildLoginModal(
  metadata: LoginOpenMetadata,
  snapshot?: AuthStatusSnapshot,
  state?: LoginFlowState,
): ModalDefinition {
  const fields = metadata.stage === 'provider'
    ? [providerField(snapshot!, metadata.authType)]
    : [promptField(state!)];
  return {
    callbackId: LOGIN_MODAL_CALLBACK,
    title: t('cmd.auth.loginModalTitle'),
    submitLabel: metadata.stage === 'provider'
      ? t('cmd.auth.loginContinue')
      : t('cmd.auth.loginSubmit'),
    closeLabel: t('cmd.auth.loginCancel'),
    privateMetadata: JSON.stringify(metadata),
    fields,
  };
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
  const authType = authTypeLabel(metadata.authType);
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
  await adapter.postMessage(loginDestination(metadata.channel), {
    text: t('cmd.auth.loginFailed', { error: t('cmd.auth.loginUnknownFailure') }),
  });
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
  await adapter.openModal(context.triggerId, buildLoginModal(metadata, snapshot, state ?? undefined));
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

function startProviderFlow(
  metadata: LoginOpenMetadata,
  provider: string,
  dependencies: InteractiveLoginDependencies,
): void {
  void dependencies.authLogin.start({
    backend: 'pi', provider, authType: metadata.authType,
    channel: metadata.channel, sessionId: null,
  }).then(state => monitorFlow(state, { ...metadata, provider }, dependencies))
    .catch(() => postBackgroundFailure(metadata, dependencies));
}

async function submitProvider(
  context: ModalSubmitContext,
  metadata: LoginOpenMetadata,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const provider = selectedValue(context, 'login_provider');
  if (!provider) {
    await context.ack({ errors: { login_provider: t('cmd.auth.loginRequired') } });
    return;
  }
  await context.ack();
  startProviderFlow(metadata, provider, dependencies);
}

async function submitLoginModal(
  context: ModalSubmitContext,
  dependencies: InteractiveLoginDependencies,
): Promise<void> {
  const metadata = JSON.parse(context.privateMetadata) as LoginOpenMetadata;
  if (metadata.stage === 'provider') return submitProvider(context, metadata, dependencies);
  const value = submittedPromptValue(context);
  if (!value) {
    await context.ack({ errors: { login_secret: t('cmd.auth.loginRequired') } });
    return;
  }
  await context.ack();
  completeLoginInBackground(metadata, value, dependencies);
}

function registerLoginInteractions(dependencies: InteractiveLoginDependencies): void {
  dependencies.router.registerCommand('login', {
    actions: [{
      actionId: 'open',
      handler: context => openLoginModal(context, dependencies),
    }],
    modals: [{
      callbackId: LOGIN_MODAL_CALLBACK,
      handler: context => submitLoginModal(context, dependencies),
    }],
  });
}

function promptResult(state: LoginFlowState, metadata: LoginOpenMetadata): CommandResult {
  const notice = state.notice ? renderNotice(state.notice) : null;
  const authType = authTypeLabel(metadata.authType);
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

function providerSelectionResult(
  channel: string,
  authType: AuthType,
  count: number,
): CommandResult {
  if (count === 0) {
    return { text: t('cmd.auth.loginNoProviders', { authType: authTypeLabel(authType) }) };
  }
  const metadata: LoginOpenMetadata = {
    backend: 'pi', authType, channel, stage: 'provider',
  };
  return {
    text: t('cmd.auth.loginChooseProvider', { authType: authTypeLabel(authType) }),
    actions: openAction(metadata, t('cmd.auth.loginChoose')),
  };
}

async function handlePiLoginRequest(
  channel: string,
  request: { kind: 'login'; backend: 'claude' | 'pi'; authType: AuthType; provider?: string },
  dependencies: ResolvedLoginDependencies,
): Promise<CommandResult> {
  const snapshot = await dependencies.readStatus();
  const providers = loginProviders(snapshot, request.authType);
  if (request.provider && !providers.some(account => account.provider === request.provider)) {
    return { text: t('cmd.auth.loginUnknownProvider', {
      provider: request.provider, authType: authTypeLabel(request.authType),
    }) };
  }
  if (request.provider) {
    return startExplicitLogin(channel, 'pi', request.provider, request.authType, dependencies);
  }
  return providerSelectionResult(channel, request.authType, providers.length);
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
    if (request.backend === 'claude') {
      return startExplicitLogin(channel, 'claude', 'anthropic', request.authType, dependencies);
    }
    return handlePiLoginRequest(channel, request, dependencies);
  };
}
