// input:  AuthInteraction, Claude auth CLI, legacy env cleanup
// output: Claude-owned subscription login consumer
// pos:    Claude subscription LoginFlow bridge
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import {
  configureEnvForMode,
  getClaudeMode,
  removeClaudeCodeOAuthToken,
} from '../agents/config.js';
import {
  ClaudeAuthCliError,
  loginClaudeAuth,
  type ClaudeAuthCliDependencies,
  type ClaudeAuthLoginOptions,
} from './cc-auth-cli.js';
import { publishAuthRecovered } from './auth-events.js';
import {
  LoginFlowError,
  type AuthInteraction,
  type LoginOutcome,
} from './login-flow.js';

const AUTH_PROMPT = 'Paste code here if prompted.';
const OUTCOME_DETAIL = 'Credential managed by Claude Code.';

export interface ClaudeSubscriptionLoginDependencies {
  login?: typeof loginClaudeAuth;
  cli?: ClaudeAuthCliDependencies;
  removeLegacyToken?: () => Promise<void>;
  reloadAuth?: () => void;
  publishRecovered?: (input: { backend: 'claude'; provider: string }) => void;
}

export interface ClaudeSubscriptionLoginOutcome extends LoginOutcome {
  provider: 'anthropic';
  authType: 'oauth';
  expiresAt: null;
  detail: string;
}

export class ClaudeSubscriptionLoginError extends LoginFlowError {}

function loginError(code: string, message: string): ClaudeSubscriptionLoginError {
  return new ClaudeSubscriptionLoginError(code, message);
}

function safeLoginError(error: unknown): ClaudeSubscriptionLoginError {
  if (error instanceof ClaudeAuthCliError) {
    if (error.code === 'claude_auth_cancelled') {
      return loginError('claude_subscription_cancelled', 'Claude subscription login was cancelled.');
    }
    if (error.code === 'claude_auth_timeout') {
      return loginError('claude_subscription_timeout', 'Claude subscription login timed out.');
    }
  }
  return loginError('claude_subscription_failed', 'Claude subscription login failed.');
}

function loginOptions(interaction: AuthInteraction): ClaudeAuthLoginOptions {
  return {
    signal: interaction.signal,
    async onAuthorization(url) {
      interaction.notify({ type: 'auth_url', url });
      return interaction.prompt({ type: 'manual_code', message: AUTH_PROMPT });
    },
    onCodeSubmitted() {
      interaction.notify({ type: 'progress', message: 'Completing Claude subscription login.' });
    },
  };
}

async function clearLegacyToken(
  dependencies: ClaudeSubscriptionLoginDependencies,
): Promise<void> {
  try {
    await (dependencies.removeLegacyToken ?? removeClaudeCodeOAuthToken)();
    (dependencies.reloadAuth ?? (() => configureEnvForMode(getClaudeMode())))();
  } catch {
    throw loginError(
      'claude_subscription_cleanup_failed',
      'Claude subscription login completed but legacy authentication cleanup failed.',
    );
  }
}

export async function loginClaudeSubscription(
  interaction: AuthInteraction,
  dependencies: ClaudeSubscriptionLoginDependencies = {},
): Promise<ClaudeSubscriptionLoginOutcome> {
  try {
    await (dependencies.login ?? loginClaudeAuth)(loginOptions(interaction), dependencies.cli);
  } catch (error) {
    throw safeLoginError(error);
  }
  await clearLegacyToken(dependencies);
  (dependencies.publishRecovered ?? publishAuthRecovered)({
    backend: 'claude', provider: 'anthropic',
  });
  return {
    provider: 'anthropic', authType: 'oauth', expiresAt: null, detail: OUTCOME_DETAIL,
  };
}
