// input:  LoginFlow interaction, saved API env, auth lifecycle
// output: Claude API-key login consumer and secret-free outcome
// pos:    Claude Code API-key login adapter
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import {
  configureEnvForMode,
  getClaudeMode,
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
  configureEnvForMode(getClaudeMode());
  publishAuthRecovered({ backend: 'claude', provider: 'anthropic' });
  return { provider: 'anthropic', authType: 'api_key', expiresAt: null };
}
