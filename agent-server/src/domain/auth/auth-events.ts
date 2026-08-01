// input:  provider error messages, run identity, shared EventBus
// output: auth classification and required/recovered lifecycle events
// pos:    Authentication failure event publisher
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { AuthErrorKind, EventBus } from '@events/index.js';

const AUTH_ERROR_PATTERNS: ReadonlyArray<readonly [RegExp, AuthErrorKind]> = [
  [/(?:\blogin_required\b|please\s+run\s+\/login\b)/i, 'login_required'],
  [/(?:\boauth_expired\b|oauth\s+token\s+has\s+expired\b)/i, 'oauth_expired'],
  [/(?:\bauthentication_error\b|\bauthentication\b|\binvalid[_ -]api[_ -]key\b|\binvalid\s+x-api-key\b)/i, 'invalid_api_key'],
  [/(?:\bunauthorized\b|\b401\b)/i, 'unauthorized'],
  [/\binvalid_grant\b/i, 'invalid_grant'],
];

let eventBus: EventBus | null = null;
const pendingRecovery = new Set<string>();

type AuthBackend = 'claude' | 'pi';
type AuthType = 'oauth' | 'api_key' | null;

function pairKey(backend: AuthBackend, provider: string): string {
  return `${backend}:${provider}`;
}

export function classifyAuthError(message: string): AuthErrorKind | null {
  for (const [pattern, kind] of AUTH_ERROR_PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return null;
}

export function initAuthEvents(bus: EventBus | null): void {
  eventBus = bus;
  pendingRecovery.clear();
}

export function publishAuthRequired(input: {
  backend: AuthBackend;
  provider: string;
  authType: AuthType;
  kind: AuthErrorKind;
  channel: string | null;
  sessionId: string | null;
}): void {
  if (!eventBus) return;
  pendingRecovery.add(pairKey(input.backend, input.provider));
  eventBus.publish({ type: 'auth.required', ...input });
}

export function publishAuthRecovered(input: {
  backend: AuthBackend;
  provider: string;
}): void {
  if (!eventBus || !pendingRecovery.delete(pairKey(input.backend, input.provider))) return;
  eventBus.publish({ type: 'auth.recovered', ...input });
}
