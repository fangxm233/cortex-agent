import { t } from '@core/i18n.js';
import {
  applyAuthEnv,
  removeClaudeCodeOAuthToken,
} from '../agents/config.js';
import {
  ClaudeAuthCliError,
  loginClaudeAuth,
  type ClaudeAuthLoginOptions,
} from './cc-auth-cli.js';
import { publishAuthRecovered } from './auth-events.js';
import {
  LoginFlowError,
  type AuthInteraction,
  type LoginOutcome,
} from './login-flow.js';

const OUTCOME_DETAIL = 'Credential managed by Claude Code.';

export interface ClaudeSubscriptionLoginDependencies {
  login?: typeof loginClaudeAuth;
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

function safeLoginError(error: unknown): LoginFlowError {
  if (error instanceof ClaudeAuthCliError) {
    if (error.code === 'claude_auth_cancelled') {
      return new LoginFlowError('claude_subscription_cancelled', t('ux.auth.ccCancelled'));
    }
    if (error.code === 'claude_auth_timeout') {
      return new LoginFlowError('claude_subscription_timeout', t('ux.auth.ccTimeout'));
    }
  }
  return new LoginFlowError('claude_subscription_failed', t('ux.auth.ccFailed'));
}

function loginOptions(interaction: AuthInteraction): ClaudeAuthLoginOptions {
  return {
    signal: interaction.signal,
    async onAuthorization(url) {
      interaction.notify({ type: 'auth_url', url });
      return interaction.prompt({ type: 'manual_code', message: t('ux.auth.ccPasteCode') });
    },
    onCodeSubmitted() {
      interaction.notify({ type: 'progress', message: t('ux.auth.ccCompleting') });
    },
  };
}

async function clearLegacyToken(
  dependencies: ClaudeSubscriptionLoginDependencies,
): Promise<void> {
  try {
    await (dependencies.removeLegacyToken ?? removeClaudeCodeOAuthToken)();
    (dependencies.reloadAuth ?? applyAuthEnv)();
  } catch {
    throw new LoginFlowError(
      'claude_subscription_cleanup_failed',
      t('ux.auth.ccCleanupFailed'),
    );
  }
}

export async function loginClaudeSubscription(
  interaction: AuthInteraction,
  dependencies: ClaudeSubscriptionLoginDependencies = {},
): Promise<ClaudeSubscriptionLoginOutcome> {
  try {
    await (dependencies.login ?? loginClaudeAuth)(loginOptions(interaction));
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
