import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { UiService } from '@domain/ui-service/types.js';

/**
 * Keep this module free of static runtime transport imports. The dynamic import below is the sole
 * edge from the core boot graph to @trpc/server and jose, so a disabled UI keeps them unloaded.
 */

/** The Web UI mount app.ts hangs on its main server — structural, so this module needs no transport types at runtime. */
export interface UiHttpMount {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => void;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => void;
}

/** Opt-in gate: truthy CORTEX_UI_HTTP (1/true/on/yes). start-ui-http re-checks it with this same parser. */
export function isUiHttpEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.CORTEX_UI_HTTP || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Build the Web UI HTTP+SSE handlers on demand when CORTEX_UI_HTTP is set, else return null. The
 * transport module (which pulls @trpc/server + jose) is loaded via a dynamic import that is only
 * reached inside the enabled branch, so an unset flag keeps those deps out of the runtime graph.
 * `where` names the address it will be served on, for the log line.
 */
export async function createUiHttpIfEnabled(uiService: UiService, where: string): Promise<UiHttpMount | null> {
  if (!isUiHttpEnabled(process.env)) return null;
  const { createUiHttp } = await import('./start-ui-http.js');
  // start-ui-http re-reads CORTEX_UI_HTTP and returns null when off — always truthy here.
  return createUiHttp({ uiService }, where);
}
