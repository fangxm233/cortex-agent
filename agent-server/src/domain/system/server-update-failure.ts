import { redactMessage } from '@domain/telemetry/redact.js';
import type { SystemUpdateCheckResult } from './server-update-coordinator.js';

/** Thrown by a latest-version lookup to say why it failed: `timeout`, `npm_exit:<code>`, `npm_spawn`. */
export class UpdateLookupError extends Error {
  constructor(readonly failure: string, readonly detail?: string) {
    super(detail ? `${failure}: ${detail}` : failure);
    this.name = 'UpdateLookupError';
  }
}

/** `reason` stays `check_failed` for the UI; `failure` names the cause and `detail` explains it, redacted. */
export function checkFailed(failure: string, detail?: string): SystemUpdateCheckResult {
  const text = detail?.trim();
  return { status: 'error', reason: 'check_failed', failure, ...(text ? { detail: redactMessage(text) } : {}) };
}

export function failureOf(error: unknown): SystemUpdateCheckResult {
  if (error instanceof UpdateLookupError) return checkFailed(error.failure, error.detail);
  if (error instanceof Error) return checkFailed(`exception:${error.name}`, error.message);
  return checkFailed(`exception:${typeof error}`, String(error));
}
