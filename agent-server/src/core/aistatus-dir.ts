// Where aistatus keeps its files: the usage-sharing switch (`config.yaml`) the leaderboard upload
// reads, and the `gateway.yaml` an earlier Cortex wrote. It is `.aistatus` under the OS home, or
// under `CORTEX_GATEWAY_HOME` when that is set (process env first, then config/.env — a CLI process
// reads it before any dotenv load).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { parse } from 'dotenv';

/** The setting that moves the aistatus directory under another home. */
export const AISTATUS_HOME_VAR = 'CORTEX_GATEWAY_HOME';

function readConfigEnv(configDir: string): NodeJS.ProcessEnv {
  try { return parse(readFileSync(path.join(configDir, '.env'))); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {};
}

export function resolveAistatusDir(env: NodeJS.ProcessEnv, fileEnv: NodeJS.ProcessEnv, osHome: string): string {
  const home = env[AISTATUS_HOME_VAR] ?? fileEnv[AISTATUS_HOME_VAR];
  if (home === undefined) return path.join(osHome, '.aistatus');
  if (!path.isAbsolute(home)) throw new Error(`${AISTATUS_HOME_VAR} must be an absolute path`);
  return path.join(path.resolve(home), '.aistatus');
}

export function loadAistatusDir(configDir: string, env = process.env, osHome = homedir()): string {
  return resolveAistatusDir(env, readConfigEnv(configDir), osHome);
}
