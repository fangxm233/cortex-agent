// input:  auth mutation args and shared backend login service
// output: Result envelopes for start, response, and cancellation
// pos:    Write handlers for Web-managed LoginFlow sessions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import {
  authLoginService,
  isLoginFlowError,
  type AuthLoginService,
  type LoginFlowState,
} from '@domain/auth/index.js';
import type {
  AuthCancelFlowArgs,
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

export async function handleAuthStartLogin(
  deps: UiServiceDeps,
  args: AuthStartLoginArgs,
): Promise<Result<LoginFlowState>> {
  return asResult(() => serviceFor(deps).start({
    ...args,
    channel: null,
    sessionId: null,
  }));
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
