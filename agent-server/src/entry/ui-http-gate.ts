// input:  UiService, CORTEX_UI_HTTP environment flag
// output: optional Web UI HTTP server handle
// pos:    Lazily gates the Web UI HTTP transport startup
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { UiService } from '@domain/ui-service/types.js';

/**
 * Keep this module free of static runtime transport imports. The dynamic import below is the sole
 * edge from the core boot graph to @trpc/server and jose, so a disabled UI keeps them unloaded.
 */

/** Handle app.ts holds for shutdown — structural, so this module needs no transport types at runtime. */
export interface UiHttpHandle {
  close: () => Promise<void>;
}

/** Opt-in gate: truthy CORTEX_UI_HTTP (1/true/on/yes). Mirrors start-ui-http's own re-check. */
function isEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.CORTEX_UI_HTTP || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Start the Web UI HTTP+SSE transport-host on demand when CORTEX_UI_HTTP is set, else return null.
 * The transport module (which pulls @trpc/server + jose) is loaded via a dynamic import that is
 * only reached inside the enabled branch, so an unset flag keeps those deps out of the runtime graph.
 */
export async function startUiHttpIfEnabled(
  uiService: UiService,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UiHttpHandle | null> {
  if (!isEnabled(env)) return null;
  const { startUiHttpServer } = await import('./start-ui-http.js');
  // start-ui-http re-reads CORTEX_UI_HTTP and returns null when off — always truthy here.
  return startUiHttpServer({ uiService }) ?? null;
}
