import {
  applyAuthEnv,
  saveAnthropicApiKey,
} from '../agents/config.js';
import { publishAuthRecovered } from './auth-events.js';
import type { AuthInteraction, LoginOutcome } from './login-flow.js';

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
    message: 'Enter your Anthropic API key.',
  });
  await saveAnthropicApiKey(apiKey);
  applyAuthEnv();
  publishAuthRecovered({ backend: 'claude', provider: 'anthropic' });
  return { provider: 'anthropic', authType: 'api_key', expiresAt: null };
}
