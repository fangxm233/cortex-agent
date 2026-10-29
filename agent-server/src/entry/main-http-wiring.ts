import * as path from 'path';
import { getClientToken } from '@core/auth.js';
import { EXIT_PORT_UNAVAILABLE, portUnavailableMessage, writeAppStop } from '@core/app-stop.js';
import { createLogger } from '@core/log.js';
import {
  DEFAULT_MAIN_HOST, LEGACY_CLIENT_PORT_ENV, MAIN_HOST_ENV, MAIN_PORT_ENV, parsePort, resolveMainPort, warnRetiredPortEnv,
} from '@core/main-port.js';
import { CONFIG_DIR } from '@core/paths.js';
import { handleClientUpgrade, startClientManager } from '@domain/remote/client-manager.js';
import { createMainHttpServer, type MainHttpServer } from '@platform/main-http/main-server.js';

const log = createLogger('main-http');
const ENV_FILE = path.join(CONFIG_DIR, '.env');

export interface MainServerHandle {
  server: MainHttpServer;
  port: number;
  host: string;
}

/**
 * Resolve the main port and build the server (not yet listening). The port goes into process.env so
 * every process this one spawns — Claude, PI's tools, MCP sidecars, hooks — reaches this instance.
 */
export function createMainServer(env: NodeJS.ProcessEnv = process.env): MainServerHandle {
  const port = resolveMainPort(env, ENV_FILE);
  env[MAIN_PORT_ENV] = String(port);
  warnRetiredPortEnv(env, (message) => log.warn(message));
  const host = (env[MAIN_HOST_ENV] || '').trim() || DEFAULT_MAIN_HOST;
  return { server: createMainHttpServer({ port, host, getClientToken }), port, host };
}

/**
 * Bind the main port, or record why it could not be bound and exit with EXIT_PORT_UNAVAILABLE —
 * the daemon does not restart on that code, since another try would fail the same way.
 */
export async function listenOrExit(handle: MainServerHandle): Promise<void> {
  try {
    await handle.server.listen();
    log.info(`Listening on ${handle.host}:${handle.port}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = portUnavailableMessage(handle.port, handle.host, code, ENV_FILE);
    log.error(message);
    writeAppStop({
      code: EXIT_PORT_UNAVAILABLE,
      reason: code === 'EADDRINUSE' ? 'port-in-use' : 'port-unavailable',
      port: handle.port,
      host: handle.host,
      message,
      at: new Date().toISOString(),
    });
    process.exit(EXIT_PORT_UNAVAILABLE);
  }
}

/**
 * Start the client hub on the main port. An install whose remote clients still dial the old
 * dedicated port keeps CORTEX_CLIENT_PORT in its .env; the hub then also listens there (on
 * CORTEX_CLIENT_HOST), and local clients and SSH reverse routes keep using that port.
 */
export function startClientHub(handle: MainServerHandle, env: NodeJS.ProcessEnv = process.env): void {
  const legacyPort = parsePort(env[LEGACY_CLIENT_PORT_ENV]);
  if (legacyPort) startClientManager(legacyPort, env.CORTEX_CLIENT_HOST);
  else startClientManager(handle.port, undefined, { listen: false });
  handle.server.mountClient(handleClientUpgrade);
}
