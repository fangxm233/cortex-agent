// input:  PI ExtensionAPI, provider response headers, codex quota codec
// output: provider quota readings handed to the host as they arrive
// pos:    Reports provider quota read off PI response headers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { parseCodexQuotaHeaders, type CodexQuotaReading } from '@domain/costs/codex-quota.js';

interface AfterProviderResponseEvent {
  status?: number;
  headers?: unknown;
}

function headersOf(event: AfterProviderResponseEvent): Record<string, string> | null {
  const headers = event?.headers;
  return headers && typeof headers === 'object' && !Array.isArray(headers)
    ? headers as Record<string, string>
    : null;
}

/**
 * Report what the provider says about its own quota. Codex publishes utilization on every response
 * header set — including error responses — so the probe reads each one and hands the reading to
 * the host directly; the session runs in the host's process, so no wire channel is needed.
 *
 * Everything here is best-effort: a throw would surface as an `extension_error` and pollute the
 * turn, so a broken reporter simply costs one reading. The next response carries a fresh
 * snapshot, and a missing reading is never read as "quota is fine".
 */
export function createQuotaProbe(report: (reading: CodexQuotaReading) => void): ExtensionFactory {
  return (pi) => {
    pi.on('after_provider_response', (event: AfterProviderResponseEvent) => {
      try {
        const headers = headersOf(event);
        if (!headers) return;
        const reading = parseCodexQuotaHeaders(headers, { nowMs: Date.now() });
        if (reading) report(reading);
      } catch {
        // Reporting is advisory; never fail the provider call over it.
      }
    });
  };
}
