import { t } from '@core/i18n.js';
import {
  authLoginService,
  bindAuthNoticeFlow,
  isLoginFlowError,
  logoutAccount,
  resolveAuthNoticeFlow,
  syncGatewayFromBackends,
  type AuthLoginService,
  type LoginFlowState,
} from '@domain/auth/index.js';
import type {
  AuthCancelFlowArgs,
  AuthLogoutArgs,
  AuthLogoutReturn,
  AuthRespondPromptArgs,
  AuthStartLoginArgs,
  AuthSyncGatewayArgs,
  AuthSyncGatewayReturn,
  Result,
  UiServiceDeps,
} from '../types.js';

function serviceFor(deps: UiServiceDeps): AuthLoginService {
  return deps.authLogin ?? authLoginService;
}

// The coordinator's state errors are plain Errors rendered in the active locale; recognise them
// by the same rendering.
const FLOW_STATE_ERRORS: ReadonlyArray<[key: string, code: string]> = [
  ['ux.auth.flowNotFound', 'not-found'],
  ['ux.auth.flowNotActive', 'already-terminal'],
  ['ux.auth.flowNotWaiting', 'invalid-args'],
];

function failure(error: unknown): Result<never> {
  const message = error instanceof Error ? error.message : String(error);
  const stateError = FLOW_STATE_ERRORS.find(([key]) => message === t(key));
  if (stateError) return { ok: false, code: stateError[1], message };
  if (isLoginFlowError(error)) {
    const code = error.code === 'flow_conflict' ? 'already-exists' : 'invalid-args';
    return { ok: false, code, message: error.message };
  }
  return { ok: false, code: 'internal', message: t('ux.auth.flowFailed') };
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
  return { ok: false, code: 'not-found', message: t('ux.auth.flowNotFound') };
}

function startWebFlow(service: AuthLoginService, args: AuthStartLoginArgs) {
  const { noticeId, ...input } = args;
  const options = noticeId ? { reuseExistingPair: true } : undefined;
  return service.start({ ...input, channel: null, sessionId: null }, options);
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
      : { ok: false, code: 'already-exists', message: t('ux.auth.activeElsewhere') };
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

/**
 * Re-derive gateway modes and profiles from the backends this machine can reach.
 *
 * Runs automatically after a login (see the `onLoginSuccess` wiring in entry/app.ts); this is the
 * manual entry point for the cases that misses — a credential that predates the automatic sync, or
 * a provider scan that failed transiently. Finding nothing to configure is a legitimate outcome and
 * comes back as `ok` with `configured: false`, so the caller can explain rather than show an error.
 */
export async function handleAuthSyncGateway(
  deps: UiServiceDeps,
  args: AuthSyncGatewayArgs,
): Promise<Result<AuthSyncGatewayReturn>> {
  const sync = deps.syncGateway ?? syncGatewayFromBackends;
  const result = await sync({ backends: args.backend ? [args.backend] : undefined });
  return {
    ok: true,
    data: {
      configured: result.configured,
      endpoints: result.endpoints,
      profiles: result.profiles,
      ...(result.reason ? { reason: result.reason } : {}),
    },
  };
}
