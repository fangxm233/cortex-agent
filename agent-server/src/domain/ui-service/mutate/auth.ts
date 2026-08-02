// input:  auth mutation args and backend login/logout services
// output: Web login flow and account logout results
// pos:    Write handlers for Web authentication mutations
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import {
  authLoginService,
  bindAuthNoticeFlow,
  isLoginFlowError,
  logoutAccount,
  resolveAuthNoticeFlow,
  type AuthLoginService,
  type LoginFlowState,
} from '@domain/auth/index.js';
import type {
  AuthCancelFlowArgs,
  AuthLogoutArgs,
  AuthLogoutReturn,
  AuthRespondPromptArgs,
  AuthStartLoginArgs,
  Result,
  UiServiceDeps,
} from '../types.js';

function serviceFor(deps: UiServiceDeps): AuthLoginService {
  return deps.authLogin ?? authLoginService;
}

function failure(error: unknown): Result<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'Login flow not found or expired.') {
    return { ok: false, code: 'not-found', message };
  }
  if (message === 'Login flow is not active.') {
    return { ok: false, code: 'already-terminal', message };
  }
  if (message === 'Login flow is not waiting for a prompt response.') {
    return { ok: false, code: 'invalid-args', message };
  }
  if (isLoginFlowError(error)) {
    const code = error.code === 'flow_conflict' ? 'already-exists' : 'invalid-args';
    return { ok: false, code, message: error.message };
  }
  return { ok: false, code: 'internal', message: 'Authentication flow failed.' };
}

async function asResult(operation: () => Promise<LoginFlowState>): Promise<Result<LoginFlowState>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return failure(error);
  }
}

function isWebOwned(service: AuthLoginService, flowId: string): boolean {
  const state = service.getState(flowId);
  return !!state && state.channel === null && state.sessionId === null;
}

function missingWebFlow(): Result<never> {
  return { ok: false, code: 'not-found', message: 'Login flow not found or expired.' };
}

function startWebFlow(service: AuthLoginService, args: AuthStartLoginArgs) {
  const { noticeId: _noticeId, ...input } = args;
  return service.start({ ...input, channel: null, sessionId: null });
}

async function startWebNoticeFlow(
  service: AuthLoginService,
  args: AuthStartLoginArgs & { noticeId: string },
): Promise<Result<LoginFlowState>> {
  const resolved = resolveAuthNoticeFlow(service, args.noticeId);
  if (resolved.kind === 'expired') return missingWebFlow();
  if (resolved.kind === 'state') {
    return resolved.state.channel === null && resolved.state.sessionId === null
      ? { ok: true, data: resolved.state }
      : { ok: false, code: 'already-exists', message: 'Login is active on another surface.' };
  }
  const result = await asResult(() => startWebFlow(service, args));
  if (result.ok) bindAuthNoticeFlow(service, args.noticeId, result.data.flowId);
  return result;
}

export async function handleAuthStartLogin(
  deps: UiServiceDeps,
  args: AuthStartLoginArgs,
): Promise<Result<LoginFlowState>> {
  const service = serviceFor(deps);
  if (args.noticeId) return startWebNoticeFlow(service, { ...args, noticeId: args.noticeId });
  return asResult(() => startWebFlow(service, args));
}

export async function handleAuthRespondPrompt(
  deps: UiServiceDeps,
  args: AuthRespondPromptArgs,
): Promise<Result<LoginFlowState>> {
  const service = serviceFor(deps);
  if (!isWebOwned(service, args.flowId)) return missingWebFlow();
  return asResult(() => service.respond(args.flowId, args.value));
}

export async function handleAuthCancelFlow(
  deps: UiServiceDeps,
  args: AuthCancelFlowArgs,
): Promise<Result<LoginFlowState>> {
  const service = serviceFor(deps);
  if (!isWebOwned(service, args.flowId)) return missingWebFlow();
  return asResult(() => service.cancel(args.flowId));
}

export async function handleAuthLogout(
  deps: UiServiceDeps,
  args: AuthLogoutArgs,
): Promise<Result<AuthLogoutReturn>> {
  const result = await (deps.logoutAccount ?? logoutAccount)(args);
  if (result.ok === true) return { ok: true, data: result };
  return { ok: false, code: result.error.code, message: result.error.message };
}
