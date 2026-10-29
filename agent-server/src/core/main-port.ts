import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

/**
 * The one port a Cortex instance listens on. The Web UI, the webhook routes, cortex-client and the
 * TUI sockets all share it, so a second instance on the same machine needs only its own value.
 * The name predates the consolidation (it was the Web UI's port) and is kept so existing tunnels,
 * desktop apps and `.env` files keep working.
 */
export const MAIN_PORT_ENV = 'CORTEX_UI_PORT';
export const DEFAULT_MAIN_PORT = 26789;
export const MAIN_HOST_ENV = 'CORTEX_UI_HOST';
export const DEFAULT_MAIN_HOST = '127.0.0.1';
/** WebSocket path of the `cortex tui` client on the main port. */
export const TUI_PATH = '/tui';
/** Set only on installs whose remote clients still dial the old dedicated client port. */
export const LEGACY_CLIENT_PORT_ENV = 'CORTEX_CLIENT_PORT';

/** Ports the main port replaced. Still read nowhere; named so a stale setting is reported once. */
const RETIRED_PORT_ENVS = ['WEBHOOK_PORT', 'CORTEX_TUI_PORT'] as const;

/** A TCP port in 1..65535, or null for anything else (unset, blank, not an integer). */
export function parsePort(value: string | undefined): number | null {
  const text = (value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** `$CORTEX_HOME/config/.env`, resolved from `env` the way the server resolves its home. */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CORTEX_HOME ? path.resolve(env.CORTEX_HOME) : path.join(os.homedir(), '.cortex');
  return path.join(home, 'config', '.env');
}

/** One key of a dotenv file, or undefined when the file or the key is missing. */
export function readEnvFileValue(file: string, key: string): string | undefined {
  try {
    return dotenv.parse(fs.readFileSync(file))[key];
  } catch {
    return undefined;
  }
}

/**
 * The main port: the process env first (the server writes the port it bound there, so everything it
 * spawns inherits it), then the home's `.env` (a CLI run from a plain shell), then the default.
 * `file: null` skips the `.env` step, for code that only ever runs under the server.
 */
export function resolveMainPort(env: NodeJS.ProcessEnv = process.env, file: string | null = envFilePath(env)): number {
  const fromFile = file === null ? undefined : readEnvFileValue(file, MAIN_PORT_ENV);
  return parsePort(env[MAIN_PORT_ENV]) ?? parsePort(fromFile) ?? DEFAULT_MAIN_PORT;
}

/** Loopback root of this instance's main port, e.g. `http://127.0.0.1:26789`. */
export function mainPortUrl(env: NodeJS.ProcessEnv = process.env, file: string | null = envFilePath(env)): string {
  return `http://127.0.0.1:${resolveMainPort(env, file)}`;
}

/** The client token from the process env, else the home's `.env` (the TUI runs from a plain shell). */
export function resolveClientToken(env: NodeJS.ProcessEnv = process.env, file = envFilePath(env)): string {
  return (env.CORTEX_CLIENT_TOKEN || readEnvFileValue(file, 'CORTEX_CLIENT_TOKEN') || '').trim();
}

const warnedRetired = new Set<string>();

/** Report each retired port variable once per process; its value is never used. */
export function warnRetiredPortEnv(env: NodeJS.ProcessEnv, warn: (message: string) => void): void {
  for (const name of RETIRED_PORT_ENVS) {
    if (!env[name] || warnedRetired.has(name)) continue;
    warnedRetired.add(name);
    warn(`${name} is no longer used and is ignored: every endpoint is served on ${MAIN_PORT_ENV} `
      + `(${resolveMainPort(env)}). Remove ${name} from your environment or ${envFilePath(env)}.`);
  }
}
