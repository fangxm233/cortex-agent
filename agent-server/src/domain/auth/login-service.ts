// input:  LoginFlow API and Claude/PI login consumers
// output: shared login service, notice bindings, and cancel fencing
// pos:    Selects one credential adapter per LoginFlow start request
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

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
  start(input: StartLoginFlowInput): Promise<LoginFlowState>;
  getState(flowId: string): LoginFlowState | null;
  respond(flowId: string, value: string): Promise<LoginFlowState>;
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

const TERMINAL_STEPS = new Set(['done', 'failed', 'cancelled']);

function selectConsumer(
  input: StartLoginFlowInput,
  dependencies: AuthLoginServiceDependencies,
): LoginFlowConsumer {
  return input.backend === 'claude'
    ? selectClaudeConsumer(input, dependencies)
    : selectPiConsumer(input, dependencies);
}

function createFlowOperations(
  dependencies: AuthLoginServiceDependencies,
): Pick<AuthLoginService, 'getState' | 'respond' | 'cancel'> {
  const handedOff = new Set<string>();
  return {
    getState(flowId) {
      const state = (dependencies.getFlowState ?? getFlowState)(flowId);
      if (!state || TERMINAL_STEPS.has(state.step)) handedOff.delete(flowId);
      return state;
    },
    async respond(flowId, value) {
      const previouslyHandedOff = handedOff.has(flowId);
      handedOff.add(flowId);
      try {
        return await (dependencies.respondPrompt ?? respondPrompt)(flowId, value);
      } catch (error) {
        if (!previouslyHandedOff) handedOff.delete(flowId);
        throw error;
      }
    },
    async cancel(flowId) {
      if (handedOff.has(flowId)) {
        throw new LoginFlowError('flow_conflict', 'Login credential handoff is already in progress.');
      }
      return (dependencies.cancelFlow ?? cancelFlow)(flowId);
    },
  };
}

export function createAuthLoginService(
  dependencies: AuthLoginServiceDependencies = {},
): AuthLoginService {
  return {
    async start(input) {
      const consumer = selectConsumer(input, dependencies);
      const state = await (dependencies.startFlow ?? startFlow)(input, consumer);
      if (state.channel !== input.channel || state.sessionId !== input.sessionId) {
        throw new LoginFlowError('flow_conflict', 'Login is already active on another surface.');
      }
      return state;
    },
    ...createFlowOperations(dependencies),
  };
}

export const authLoginService = createAuthLoginService();
