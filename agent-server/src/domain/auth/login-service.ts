// input:  LoginFlow API and Claude/PI API-key consumers
// output: shared backend login service for chat and Web
// pos:    Selects one credential adapter per LoginFlow start request
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { loginClaudeApiKey } from './cc-login.js';
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

export interface AuthLoginService {
  start(input: StartLoginFlowInput): Promise<LoginFlowState>;
  getState(flowId: string): LoginFlowState | null;
  respond(flowId: string, value: string): Promise<LoginFlowState>;
  cancel(flowId: string): Promise<LoginFlowState>;
}

export interface AuthLoginServiceDependencies {
  startFlow?: typeof startFlow;
  getFlowState?: typeof getFlowState;
  respondPrompt?: typeof respondPrompt;
  cancelFlow?: typeof cancelFlow;
  claudeConsumer?: LoginFlowConsumer;
  piConsumerFactory?: (provider: string) => LoginFlowConsumer;
}

function selectConsumer(
  input: StartLoginFlowInput,
  dependencies: AuthLoginServiceDependencies,
): LoginFlowConsumer {
  if (input.authType !== 'api_key') {
    throw new LoginFlowError('unsupported_auth_type', 'Only API-key login is available.');
  }
  if (input.backend === 'claude') {
    if (input.provider !== 'anthropic') {
      throw new LoginFlowError('provider_not_found', 'Claude provider must be anthropic.');
    }
    return dependencies.claudeConsumer ?? loginClaudeApiKey;
  }
  if (!input.provider.trim()) {
    throw new LoginFlowError('provider_not_found', 'PI provider is required.');
  }
  return (dependencies.piConsumerFactory ?? createPiApiKeyLoginConsumer)(input.provider);
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
    getState(flowId) {
      return (dependencies.getFlowState ?? getFlowState)(flowId);
    },
    respond(flowId, value) {
      return (dependencies.respondPrompt ?? respondPrompt)(flowId, value);
    },
    cancel(flowId) {
      return (dependencies.cancelFlow ?? cancelFlow)(flowId);
    },
  };
}

export const authLoginService = createAuthLoginService();
