import { accountIdOf } from '@core/connections-file.js';
import { t } from '@core/i18n.js';
import { ensureClaudeAccountDir } from '../connections/claude-account-dir.js';
import { findAccount } from '../connections/accounts.js';
import { loginClaudeApiKey } from './cc-login.js';
import { loginClaudeSubscription } from './cc-subscription.js';
import {
  cancelFlow,
  getFlowState,
  LoginFlowError,
  respondPrompt,
  startFlow,
  type LoginFlowConsumer,
  type LoginFlowState,
  type StartLoginFlowInput,
} from './login-flow.js';
import { createPiApiKeyLoginConsumer } from './pi-login.js';
import { createPiOAuthLoginConsumer } from './pi-oauth.js';

/** Observes how a flow's login ends, before the flow itself settles. A throwing hook is logged by
 *  nobody: hooks own their errors. */
export interface LoginFlowHooks {
  onSuccess?: () => void | Promise<void>;
  /** A failure, a cancel, or an expiry. */
  onFailure?: () => void | Promise<void>;
}

export interface AuthLoginService {
  /** Starts a fresh flow; an unfinished one for the same backend, provider and account is
   *  cancelled. */
  start(input: StartLoginFlowInput, hooks?: LoginFlowHooks): Promise<LoginFlowState>;
  getState(flowId: string): LoginFlowState | null;
  respond(flowId: string, value: string, promptId?: number): Promise<LoginFlowState>;
  cancel(flowId: string): Promise<LoginFlowState>;
}

export type AuthNoticeFlowResolution =
  | { kind: 'unbound' }
  | { kind: 'expired' }
  | { kind: 'state'; state: LoginFlowState };

const authNoticeBindings = new WeakMap<AuthLoginService, Map<string, string>>();

function noticeBindings(service: AuthLoginService): Map<string, string> {
  const existing = authNoticeBindings.get(service);
  if (existing) return existing;
  const created = new Map<string, string>();
  authNoticeBindings.set(service, created);
  return created;
}

export function bindAuthNoticeFlow(
  service: AuthLoginService,
  noticeId: string,
  flowId: string,
): void {
  noticeBindings(service).set(noticeId, flowId);
}

export function resolveAuthNoticeFlow(
  service: AuthLoginService,
  noticeId: string,
  explicitFlowId?: string,
): AuthNoticeFlowResolution {
  const flowId = explicitFlowId ?? noticeBindings(service).get(noticeId);
  if (!flowId) return { kind: 'unbound' };
  const state = service.getState(flowId);
  return state ? { kind: 'state', state } : { kind: 'expired' };
}

/** The flow a notice's login button reopens: one still running, or a success to replay. A notice
 *  whose flow failed, was cancelled or expired starts a fresh login instead. */
export function resumableNoticeFlow(resolution: AuthNoticeFlowResolution): LoginFlowState | null {
  if (resolution.kind !== 'state') return null;
  const { step } = resolution.state;
  return step === 'failed' || step === 'cancelled' ? null : resolution.state;
}

export interface AuthLoginServiceDependencies {
  startFlow?: typeof startFlow;
  getFlowState?: typeof getFlowState;
  respondPrompt?: typeof respondPrompt;
  cancelFlow?: typeof cancelFlow;
  claudeConsumer?: LoginFlowConsumer;
  claudeOAuthConsumer?: LoginFlowConsumer;
  /** The login of one Claude account; given its id. */
  claudeAccountConsumerFactory?: (connection: string) => LoginFlowConsumer;
  piConsumerFactory?: (provider: string) => LoginFlowConsumer;
  piOAuthConsumerFactory?: (provider: string) => LoginFlowConsumer;
}

/** An account signs in to its own config dir; Cortex's own subscription and API key are not
 *  accounts. */
function accountOf(input: StartLoginFlowInput): string | null {
  return accountIdOf(input.connection);
}

function claudeAccountConsumer(connection: string): LoginFlowConsumer {
  return interaction => loginClaudeSubscription(interaction, {
    account: { id: connection, configDir: ensureClaudeAccountDir(connection) },
  });
}

function selectClaudeAccountConsumer(
  input: StartLoginFlowInput,
  connection: string,
  dependencies: AuthLoginServiceDependencies,
): LoginFlowConsumer {
  if (input.authType !== 'oauth' || !findAccount({ backend: 'claude', id: connection })) {
    throw new LoginFlowError('account_not_found', t('account.issue.not-found'));
  }
  return (dependencies.claudeAccountConsumerFactory ?? claudeAccountConsumer)(connection);
}

function selectClaudeConsumer(
  input: StartLoginFlowInput,
  dependencies: AuthLoginServiceDependencies,
): LoginFlowConsumer {
  if (input.provider !== 'anthropic') {
    throw new LoginFlowError('provider_not_found', 'Claude provider must be anthropic.');
  }
  const account = accountOf(input);
  if (account) return selectClaudeAccountConsumer(input, account, dependencies);
  return input.authType === 'oauth'
    ? dependencies.claudeOAuthConsumer ?? loginClaudeSubscription
    : dependencies.claudeConsumer ?? loginClaudeApiKey;
}

function selectPiConsumer(
  input: StartLoginFlowInput,
  dependencies: AuthLoginServiceDependencies,
): LoginFlowConsumer {
  if (!input.provider.trim()) {
    throw new LoginFlowError('provider_not_found', 'A provider is required.');
  }
  if (accountOf(input)) throw new LoginFlowError('account_not_supported', t('account.issue.not-supported'));
  const factory = input.authType === 'oauth'
    ? dependencies.piOAuthConsumerFactory ?? createPiOAuthLoginConsumer
    : dependencies.piConsumerFactory ?? createPiApiKeyLoginConsumer;
  return factory(input.provider);
}

function selectConsumer(
  input: StartLoginFlowInput,
  dependencies: AuthLoginServiceDependencies,
): LoginFlowConsumer {
  return input.backend === 'claude'
    ? selectClaudeConsumer(input, dependencies)
    : selectPiConsumer(input, dependencies);
}

function withHooks(consumer: LoginFlowConsumer, hooks: LoginFlowHooks | undefined): LoginFlowConsumer {
  if (!hooks) return consumer;
  return async interaction => {
    let outcome: Awaited<ReturnType<LoginFlowConsumer>>;
    try {
      outcome = await consumer(interaction);
    } catch (error) {
      await hooks.onFailure?.();
      throw error;
    }
    await hooks.onSuccess?.();
    return outcome;
  };
}

export function createAuthLoginService(
  dependencies: AuthLoginServiceDependencies = {},
): AuthLoginService {
  return {
    async start(input, hooks) {
      const consumer = withHooks(selectConsumer(input, dependencies), hooks);
      return (dependencies.startFlow ?? startFlow)(input, consumer);
    },
    getState: flowId => (dependencies.getFlowState ?? getFlowState)(flowId),
    respond: (flowId, value, promptId) => (
      (dependencies.respondPrompt ?? respondPrompt)(flowId, value, promptId)
    ),
    cancel: flowId => (dependencies.cancelFlow ?? cancelFlow)(flowId),
  };
}

export const authLoginService = createAuthLoginService();
