import * as path from 'path';
import { CONNECTION_ID_RE } from '@core/connections-file.js';
import { DATA_DIR, PI_ACCOUNTS_HOME } from '@core/paths.js';
import { piUserAuthPath } from '@core/pi-sdk.js';

/** PI_CODING_AGENT_DIR: PI reads models.json from this dir (auth.json: see piAuthPath). Daemon
 *  default only — a trial derives its own agent dir from the trial root (design §13 A1). */
export const PI_AGENT_DIR = path.join(DATA_DIR, 'data', 'pi');
export const PI_SESSIONS_DIR = path.join(DATA_DIR, 'logs', 'sessions-pi');

/** The auth.json a PI agent dir authenticates with — the only resolver of that path. Cortex's own
 *  agent dir uses PI's own store (`~/.pi/agent/auth.json`) directly, so a token PI refreshes lands
 *  in the one file the `pi` CLI and Cortex's login and logout also read; any other agent dir — a
 *  trial's — carries its own. */
export function piAuthPath(agentDir: string = PI_AGENT_DIR): string {
  return path.resolve(agentDir) === path.resolve(PI_AGENT_DIR)
    ? piUserAuthPath()
    : path.join(agentDir, 'auth.json');
}

/** PI's models.json always lives beside auth.json inside the agent dir, so one parameter fixes
 *  both (design §13 P7 / A3): a trial agent dir implies a trial provider catalog. */
export function piModelsPath(agentDir: string): string {
  return path.join(agentDir, 'models.json');
}

/** The agent dir of one PI account: its own auth.json, and the catalog Cortex writes beside it. */
export function piAccountDir(id: string, accountsDir: string = PI_ACCOUNTS_HOME): string {
  if (!CONNECTION_ID_RE.test(id)) throw new Error(`Invalid account id: ${id}`);
  return path.join(accountsDir, id);
}
