// input:  auth notice targets, AuthLoginService, platform actions
// output: one-click notification flow start, reuse, and stale feedback
// pos:    Coordinates actionable Slack and Feishu auth notices
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { t } from '@core/i18n.js';
import type { AuthNoticeAction } from '@core/types/agent-types.js';
import {
  bindAuthNoticeFlow,
  isLoginFlowError,
  resolveAuthNoticeFlow,
  type AuthLoginService,
  type LoginFlowState,
} from '@domain/auth/index.js';
import type {
  ActionContext,
  ButtonElement,
  PlatformAdapter,
} from '@platform/index.js';

export interface AuthRequiredLoginMetadata {
  backend: 'claude' | 'pi';
  provider: string;
  authType: 'oauth' | 'api_key';
  flowId?: string;
  noticeId: string;
  noticeText: string;
  channel: string;
  stage: 'notice';
}

export interface AuthRequiredLoginDependencies {
  adapter: PlatformAdapter;
  authLogin: AuthLoginService;
  waitForActionable: (initial: LoginFlowState) => Promise<LoginFlowState>;
  present: (
    context: ActionContext,
    metadata: AuthRequiredLoginMetadata,
    state: LoginFlowState,
  ) => Promise<void>;
}

function actionButton(metadata: AuthRequiredLoginMetadata): ButtonElement {
  return {
    type: 'button',
    text: t('cmd.auth.loginAgain'),
    actionId: 'cmd:login:open',
    value: JSON.stringify(metadata),
    style: 'primary',
  };
}

export function buildAuthRequiredLoginAction(
  action: AuthNoticeAction,
  channel: string,
  noticeText: string,
): ButtonElement {
  return actionButton({
    backend: action.backend,
    provider: action.provider,
    authType: action.authType,
    noticeId: action.noticeId,
    noticeText,
    channel,
    stage: 'notice',
  });
}

function loginDestination(channel: string) {
  return { type: 'interactive-reply' as const, conduit: channel, sessionId: '' };
}

async function postExpired(dependencies: AuthRequiredLoginDependencies, channel: string) {
  await dependencies.adapter.postMessage(loginDestination(channel), {
    text: t('cmd.auth.loginFailed', { error: t('cmd.auth.loginExpired') }),
  });
}

async function bindFlow(
  context: ActionContext,
  metadata: AuthRequiredLoginMetadata,
  state: LoginFlowState,
  dependencies: AuthRequiredLoginDependencies,
): Promise<void> {
  bindAuthNoticeFlow(dependencies.authLogin, metadata.noticeId, state.flowId);
  if (!context.messageRef) return;
  const next = { ...metadata, flowId: state.flowId };
  await dependencies.adapter.updateMessage(context.messageRef, {
    text: metadata.noticeText,
    richBlocks: [
      { type: 'section', text: metadata.noticeText, format: 'markdown' },
      { type: 'actions', elements: [actionButton(next)] },
    ],
  }).catch(() => {});
}

function failureText(error: unknown): string {
  if (isLoginFlowError(error) && error.code === 'flow_conflict') {
    return t('cmd.auth.loginAlreadyActive');
  }
  return t('cmd.auth.loginUnknownFailure');
}

async function postStartFailure(
  error: unknown,
  metadata: AuthRequiredLoginMetadata,
  dependencies: AuthRequiredLoginDependencies,
): Promise<void> {
  await dependencies.adapter.postMessage(loginDestination(metadata.channel), {
    text: t('cmd.auth.loginFailed', { error: failureText(error) }),
  });
}

async function startNotificationFlow(
  context: ActionContext,
  metadata: AuthRequiredLoginMetadata,
  dependencies: AuthRequiredLoginDependencies,
): Promise<void> {
  const state = await dependencies.authLogin.start({
    backend: metadata.backend,
    provider: metadata.provider,
    authType: metadata.authType,
    channel: metadata.channel,
    sessionId: null,
  });
  const effective = metadataForState(metadata, state);
  await bindFlow(context, effective, state, dependencies);
  const actionable = await dependencies.waitForActionable(state);
  await dependencies.present(context, effective, actionable);
}

function metadataForState(
  metadata: AuthRequiredLoginMetadata,
  state: LoginFlowState,
): AuthRequiredLoginMetadata {
  return {
    ...metadata,
    backend: state.backend,
    provider: state.provider!,
    authType: state.authType!,
    flowId: state.flowId,
  };
}

export async function openAuthRequiredLoginAction(
  context: ActionContext,
  metadata: AuthRequiredLoginMetadata,
  dependencies: AuthRequiredLoginDependencies,
): Promise<void> {
  if (!metadata.noticeId || !metadata.provider || !metadata.noticeText) return;
  if (metadata.authType !== 'oauth' && metadata.authType !== 'api_key') return;
  const resolved = resolveAuthNoticeFlow(
    dependencies.authLogin, metadata.noticeId, metadata.flowId,
  );
  if (resolved.kind === 'unbound') {
    await startNotificationFlow(context, metadata, dependencies)
      .catch(error => postStartFailure(error, metadata, dependencies));
    return;
  }
  if (resolved.kind === 'expired') return postExpired(dependencies, metadata.channel);
  const effective = metadataForState(metadata, resolved.state);
  const actionable = await dependencies.waitForActionable(resolved.state);
  await dependencies.present(context, effective, actionable);
}
