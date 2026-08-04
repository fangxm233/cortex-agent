// input:  PI ExtensionAPI, provider response headers, codex quota codec
// output: quota notices emitted on PI's fire-and-forget UI channel
// pos:    PI child-side probe reporting provider quota to the server
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { parseCodexQuotaHeaders, encodeQuotaNotice } from '@domain/costs/codex-quota.js';
import type { ExtensionAPI, ExtensionContext } from './pi-ext-types.js';

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
 * header set — including error responses — so the probe reads each one and forwards a reading over
 * `ctx.ui.notify`, the only fire-and-forget message PI's RPC mode gives an extension.
 *
 * Everything here is best-effort: a throw would surface as an `extension_error` and pollute the
 * turn, so a broken or absent UI channel simply costs one reading. The next response carries a
 * fresh snapshot, and a missing reading is never read as "quota is fine".
 */
export default function quotaProbe(pi: ExtensionAPI): void {
  pi.on('after_provider_response', (event: AfterProviderResponseEvent, ctx: ExtensionContext) => {
    try {
      const headers = headersOf(event);
      if (!headers) return;
      const reading = parseCodexQuotaHeaders(headers, { nowMs: Date.now() });
      if (!reading) return;
      ctx?.ui?.notify(encodeQuotaNotice(reading));
    } catch {
      // Reporting is advisory; never fail the provider call over it.
    }
  });
}
