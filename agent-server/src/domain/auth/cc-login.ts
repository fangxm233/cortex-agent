import { t } from '@core/i18n.js';
import {
  applyAuthEnv,
  saveAnthropicApiKey,
} from './anthropic-env.js';
import { publishAuthRecovered } from './auth-events.js';
import {
  LoginFlowError,
  failureWithDetail,
  type AuthInteraction,
  type LoginOutcome,
} from './login-flow.js';

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
    const message = failureWithDetail(t('ux.auth.apiKeySaveFailed'), error);
    throw new LoginFlowError('claude_api_key_save_failed', message, error);
  }
  applyAuthEnv();
  publishAuthRecovered({ backend: 'claude', provider: 'anthropic' });
  return { provider: 'anthropic', authType: 'api_key', expiresAt: null };
}
