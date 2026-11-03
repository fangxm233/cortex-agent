import { t } from '@core/i18n.js';
import { createLogger } from '@core/log.js';
import { usageService } from '@domain/costs/usage-service.js';
import { seedModelsFromCatalog } from '@domain/models/seed.js';
import {
  addAccount,
  authLoginService,
  bindAuthNoticeFlow,
  isLoginFlowError,
  logoutAccount,
  removeAccount,
  resolveAuthNoticeFlow,
  resumableNoticeFlow,
  type AddAccountIssue,
  type AuthLoginService,
  type LoginFlowState,
  type RemoveAccountIssue,
} from '@domain/auth/index.js';
import type {
  AuthAddAccountReturn,
  AuthLogoutReturn,
  AuthRemoveAccountReturn,
  AuthSyncModelsReturn,
  Result,
  UiServiceDeps,
  MutateArgs,
} from '../types.js';

const log = createLogger('ui-auth');

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

const LOGIN_FLOW_ERROR_CODES: Readonly<Record<string, string>> = {
  flow_conflict: 'already-exists',
  stale_prompt: 'conflict',
};

function failure(error: unknown): Result<never> {
  if (isLoginFlowError(error)) {
    return { ok: false, code: LOGIN_FLOW_ERROR_CODES[error.code] ?? 'invalid-args', message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  const stateError = FLOW_STATE_ERRORS.find(([key]) => message === t(key));
  if (stateError) return { ok: false, code: stateError[1], message };
  return { ok: false, code: 'internal', message: t('ux.auth.flowFailed') };
}

async function asResult(operation: () => Promise<LoginFlowState>): Promise<Result<LoginFlowState>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return failure(error);
  }
}

function isWebOwnedState(state: LoginFlowState): boolean {
  return state.channel === null && state.sessionId === null;
}

function isWebOwned(service: AuthLoginService, flowId: string): boolean {
  const state = service.getState(flowId);
  return !!state && isWebOwnedState(state);
}

function missingWebFlow(): Result<never> {
  return { ok: false, code: 'not-found', message: t('ux.auth.flowNotFound') };
}

function startWebFlow(service: AuthLoginService, args: MutateArgs<'auth.startLogin'>) {
  const { noticeId: _noticeId, ...input } = args;
  return service.start({ ...input, channel: null, sessionId: null });
}

async function startWebNoticeFlow(
  service: AuthLoginService,
  args: MutateArgs<'auth.startLogin'> & { noticeId: string },
): Promise<Result<LoginFlowState>> {
  const resumable = resumableNoticeFlow(resolveAuthNoticeFlow(service, args.noticeId));
  if (resumable && isWebOwnedState(resumable)) return { ok: true, data: resumable };
  const result = await asResult(() => startWebFlow(service, args));
  if (result.ok) bindAuthNoticeFlow(service, args.noticeId, result.data.flowId);
  return result;
}

export async function handleAuthStartLogin(
  deps: UiServiceDeps,
  args: MutateArgs<'auth.startLogin'>,
): Promise<Result<LoginFlowState>> {
  const service = serviceFor(deps);
  if (args.noticeId) return startWebNoticeFlow(service, { ...args, noticeId: args.noticeId });
  return asResult(() => startWebFlow(service, args));
}

export async function handleAuthRespondPrompt(
  deps: UiServiceDeps,
  args: MutateArgs<'auth.respondPrompt'>,
): Promise<Result<LoginFlowState>> {
  const service = serviceFor(deps);
  if (!isWebOwned(service, args.flowId)) return missingWebFlow();
  return asResult(() => service.respond(args.flowId, args.value, args.promptId));
}

export async function handleAuthCancelFlow(
  deps: UiServiceDeps,
  args: MutateArgs<'auth.cancelFlow'>,
): Promise<Result<LoginFlowState>> {
  const service = serviceFor(deps);
  if (!isWebOwned(service, args.flowId)) return missingWebFlow();
  return asResult(() => service.cancel(args.flowId));
}

export async function handleAuthLogout(
  deps: UiServiceDeps,
  args: MutateArgs<'auth.logout'>,
): Promise<Result<AuthLogoutReturn>> {
  const result = await (deps.logoutAccount ?? logoutAccount)(args);
  if (result.ok === true) {
    if (args.authType === 'oauth') {
      await usageService.signOut(args.provider)
        .catch((error: unknown) => log.warn(`hiding ${args.provider} subscription usage failed:`, error));
    }
    return { ok: true, data: result };
  }
  return { ok: false, code: result.error.code, message: result.error.message };
}

/** A missing account is a client error, a failed write or login start is ours, anything else a
 *  draft to fix. */
function accountFailure(errors: Array<AddAccountIssue | RemoveAccountIssue>): Result<never> {
  const internal = errors.includes('write-failed') || errors.includes('login-failed');
  const code = errors.includes('not-found') ? 'not-found' : internal ? 'internal' : 'invalid-args';
  const message = errors.map(issue => t(`account.issue.${issue}` as Parameters<typeof t>[0])).join(' ');
  return { ok: false, code, message };
}

export async function handleAuthAddAccount(
  deps: UiServiceDeps,
  args: MutateArgs<'auth.addAccount'>,
): Promise<Result<AuthAddAccountReturn>> {
  const result = await addAccount(args, { login: serviceFor(deps), ...deps.accounts });
  if (result.ok === false) return accountFailure(result.errors);
  return { ok: true, data: { account: result.account, flow: result.flow } };
}

export async function handleAuthRemoveAccount(
  deps: UiServiceDeps,
  args: MutateArgs<'auth.removeAccount'>,
): Promise<Result<AuthRemoveAccountReturn>> {
  const logout = deps.logoutAccount ?? logoutAccount;
  const result = await removeAccount(args, { logout, ...deps.accounts });
  if (result.ok === false) return accountFailure(result.errors);
  return { ok: true, data: { account: result.account, loggedOut: result.loggedOut } };
}

/**
 * Add a favorite for each route the host can now reach, and a default when none is set.
 *
 * Runs automatically after a login (see the `onLoginSuccess` wiring in entry/app.ts); this is the
 * manual entry point for the cases that misses — a credential that predates the automatic seeding,
 * or a provider scan that failed transiently. Finding nothing to seed is a legitimate outcome and
 * comes back as `ok` with `configured: false`, so the caller can explain rather than show an error.
 */
export async function handleAuthSyncModels(
  deps: UiServiceDeps,
  args: MutateArgs<'auth.syncModels'>,
): Promise<Result<AuthSyncModelsReturn>> {
  const sync = deps.syncModels ?? seedModelsFromCatalog;
  const result = await sync({ backends: args.backend ? [args.backend] : undefined });
  return {
    ok: true,
    data: {
      configured: result.configured,
      routes: result.routes,
      defaultSet: result.defaultSet,
      favorites: result.favorites,
      ...(result.reason ? { reason: result.reason } : {}),
    },
  };
}
