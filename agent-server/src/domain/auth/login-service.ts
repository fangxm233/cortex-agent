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

export interface AuthLoginService {
  /** Starts a fresh flow; an unfinished one for the same backend and provider is cancelled. */
  start(input: StartLoginFlowInput): Promise<LoginFlowState>;
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
  piConsumerFactory?: (provider: string) => LoginFlowConsumer;
  piOAuthConsumerFactory?: (provider: string) => LoginFlowConsumer;
}

function selectClaudeConsumer(
  input: StartLoginFlowInput,
  dependencies: AuthLoginServiceDependencies,
): LoginFlowConsumer {
  if (input.provider !== 'anthropic') {
    throw new LoginFlowError('provider_not_found', 'Claude provider must be anthropic.');
  }
  return input.authType === 'oauth'
    ? dependencies.claudeOAuthConsumer ?? loginClaudeSubscription
    : dependencies.claudeConsumer ?? loginClaudeApiKey;
}

function selectPiConsumer(
  input: StartLoginFlowInput,
  dependencies: AuthLoginServiceDependencies,
): LoginFlowConsumer {
  if (!input.provider.trim()) {
    throw new LoginFlowError('provider_not_found', 'PI provider is required.');
  }
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

export function createAuthLoginService(
  dependencies: AuthLoginServiceDependencies = {},
): AuthLoginService {
  return {
    async start(input) {
      return (dependencies.startFlow ?? startFlow)(input, selectConsumer(input, dependencies));
    },
    getState: flowId => (dependencies.getFlowState ?? getFlowState)(flowId),
    respond: (flowId, value, promptId) => (
      (dependencies.respondPrompt ?? respondPrompt)(flowId, value, promptId)
    ),
    cancel: flowId => (dependencies.cancelFlow ?? cancelFlow)(flowId),
  };
}

export const authLoginService = createAuthLoginService();
