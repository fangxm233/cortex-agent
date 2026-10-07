import { t } from '@core/i18n.js';
import { createLogger } from '@core/log.js';
import {
  applyAuthEnv,
  saveAnthropicApiKey,
} from './anthropic-env.js';
import { publishAuthRecovered } from './auth-events.js';
import {
  LoginFlowError,
  loginFailureMessage,
  type AuthInteraction,
  type LoginOutcome,
} from './login-flow.js';

const log = createLogger('cc-login');

export interface ClaudeApiKeyLoginOutcome extends LoginOutcome {
  provider: 'anthropic';
  authType: 'api_key';
  expiresAt: null;
}

export async function loginClaudeApiKey(
  interaction: AuthInteraction,
): Promise<ClaudeApiKeyLoginOutcome> {
  const apiKey = await interaction.prompt({
    type: 'secret',
    message: t('ux.auth.apiKeyPrompt'),
  });
  try {
    await saveAnthropicApiKey(apiKey);
  } catch (error) {
    log.warn('Anthropic API key could not be saved:', error);
    const message = loginFailureMessage(t('ux.auth.apiKeySaveFailed'), error);
    throw new LoginFlowError('claude_api_key_save_failed', message);
  }
  applyAuthEnv();
  publishAuthRecovered({ backend: 'claude', provider: 'anthropic' });
  return { provider: 'anthropic', authType: 'api_key', expiresAt: null };
}
