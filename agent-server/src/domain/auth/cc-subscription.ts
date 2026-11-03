import { t } from '@core/i18n.js';
import { removeClaudeCodeOAuthToken } from './anthropic-env.js';
import {
  ClaudeAuthCliError,
  loginClaudeAuth,
  type ClaudeAuthLoginOptions,
} from './cc-auth-cli.js';
import { publishAuthRecovered } from './auth-events.js';
import {
  LoginFlowError,
  failureWithDetail,
  type AuthInteraction,
  type LoginOutcome,
} from './login-flow.js';

const OUTCOME_DETAIL = 'Credential managed by Claude Code.';

export interface ClaudeSubscriptionLoginDependencies {
  login?: typeof loginClaudeAuth;
  removeLegacyToken?: () => Promise<void>;
  publishRecovered?: (input: { backend: 'claude'; provider: string; connection?: string | null }) => void;
  /** An account's login: its id and config dir. Absent, Cortex's own subscription. */
  account?: { id: string; configDir: string };
}

export interface ClaudeSubscriptionLoginOutcome extends LoginOutcome {
  provider: 'anthropic';
  authType: 'oauth';
  expiresAt: null;
  detail: string;
}

function loginError(error: unknown): LoginFlowError {
  if (error instanceof ClaudeAuthCliError) {
    if (error.code === 'claude_auth_cancelled') {
      return new LoginFlowError('claude_subscription_cancelled', t('ux.auth.ccCancelled'));
    }
    if (error.code === 'claude_auth_timeout') {
      return new LoginFlowError('claude_subscription_timeout', t('ux.auth.ccTimeout'));
    }
  }
  const message = failureWithDetail(t('ux.auth.ccFailed'), error);
  return new LoginFlowError('claude_subscription_failed', message, error);
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
  } catch (error) {
    throw new LoginFlowError(
      'claude_subscription_cleanup_failed',
      failureWithDetail(t('ux.auth.ccCleanupFailed'), error),
      error,
    );
  }
}

export async function loginClaudeSubscription(
  interaction: AuthInteraction,
  dependencies: ClaudeSubscriptionLoginDependencies = {},
): Promise<ClaudeSubscriptionLoginOutcome> {
  const account = dependencies.account;
  try {
    await (dependencies.login ?? loginClaudeAuth)(loginOptions(interaction), { configDir: account?.configDir });
  } catch (error) {
    throw loginError(error);
  }
  // A legacy static token only ever stood in for Cortex's own subscription.
  if (!account) await clearLegacyToken(dependencies);
  (dependencies.publishRecovered ?? publishAuthRecovered)({
    backend: 'claude', provider: 'anthropic', connection: account?.id ?? null,
  });
  return {
    provider: 'anthropic', authType: 'oauth', expiresAt: null, detail: OUTCOME_DETAIL,
  };
}
