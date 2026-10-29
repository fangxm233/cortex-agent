import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { createLogger } from '@core/log.js';
import { LEGACY_CLIENT_PORT_ENV, MAIN_PORT_ENV } from '@core/main-port.js';

const log = createLogger('version-migrations');

/** Where an install was reached before one port served everything. */
const PRE_MAIN_PORT_UI = '3004';
const PRE_MAIN_PORT_CLIENT = '3002';

interface MachineLike {
  cortexPath?: unknown;
  ssh?: unknown;
  clientCommand?: unknown;
  clientConnection?: unknown;
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'on', 'yes'].includes((value ?? '').trim().toLowerCase());
}

async function readDotenv(file: string): Promise<{ text: string; values: Record<string, string> }> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return { text, values: dotenv.parse(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', values: {} };
    throw error;
  }
}

/** The client this install launches itself runs here; every other machine dials in from elsewhere. */
function isRemoteMachine(entry: MachineLike, dataDir: string): boolean {
  if (entry.ssh || entry.clientCommand || entry.clientConnection === 'ssh-reverse') return true;
  return typeof entry.cortexPath !== 'string' || path.resolve(entry.cortexPath) !== path.resolve(dataDir);
}

async function hasRemoteMachines(dataDir: string): Promise<boolean> {
  let registry: unknown;
  try {
    registry = JSON.parse(await fs.readFile(path.join(dataDir, 'config', 'machines.json'), 'utf8'));
  } catch {
    return false;
  }
  if (!registry || typeof registry !== 'object') return false;
  return Object.values(registry as Record<string, MachineLike>)
    .some((entry) => !!entry && typeof entry === 'object' && isRemoteMachine(entry, dataDir));
}

/**
 * Keep an upgraded install reachable where it was before the main port took over:
 *  - a Web UI that ran on the old default (no CORTEX_UI_PORT set) stays on 3004, so browsers,
 *    desktop apps and tunnels need no change;
 *  - an install with remote devices keeps a client listener on 3002 (CORTEX_CLIENT_PORT), which
 *    their configs, SSH reverse routes and tunnels point at. Deleting that line later moves every
 *    client onto the main port.
 * A new install writes neither. `env` is the running process's env, so a value set outside .env
 * counts as set. Returns the keys written.
 */
export async function keepPreMainPortEndpoints(
  dataDir: string, opts: { upgrade: boolean; env?: NodeJS.ProcessEnv },
): Promise<string[]> {
  const env = opts.env ?? process.env;
  const file = path.join(dataDir, 'config', '.env');
  const { text, values } = await readDotenv(file);
  const isSet = (key: string): boolean => !!(env[key] ?? values[key])?.trim();
  const writes: Array<[string, string]> = [];
  if (isTruthy(env.CORTEX_UI_HTTP ?? values.CORTEX_UI_HTTP) && !isSet(MAIN_PORT_ENV)) {
    writes.push([MAIN_PORT_ENV, PRE_MAIN_PORT_UI]);
  }
  if (opts.upgrade && !isSet(LEGACY_CLIENT_PORT_ENV) && await hasRemoteMachines(dataDir)) {
    writes.push([LEGACY_CLIENT_PORT_ENV, PRE_MAIN_PORT_CLIENT]);
  }
  if (writes.length === 0) return [];
  const lead = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  const block = ['', '# Kept from before Cortex served everything on one port', ...writes.map(([k, v]) => `${k}=${v}`), ''];
  // Appended, not rewritten: the file holds the tokens and keeps its owner-only mode.
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, lead + block.join('\n'), { mode: 0o600 });
  log.info(`Kept pre-main-port endpoints in ${file}: ${writes.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return writes.map(([key]) => key);
}
