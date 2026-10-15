import * as fs from 'fs';
import * as path from 'path';
import { npmPrefixFromInstallRoot } from '@core/utils.js';

/** The user's last explicit choice; `removed` keeps the server from adding the command back. */
export type TerminalCliState = 'installed' | 'removed';

export const terminalCliStateFile = (home: string): string => path.join(home, 'runtime', 'terminal-cli.json');

export function readTerminalCliState(home: string): TerminalCliState | null {
  try {
    const state = JSON.parse(fs.readFileSync(terminalCliStateFile(home), 'utf8'))?.state;
    return state === 'installed' || state === 'removed' ? state : null;
  } catch {
    return null;
  }
}

export function writeTerminalCliState(home: string, state: TerminalCliState): void {
  const file = terminalCliStateFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ state, updated_at: new Date().toISOString() }, null, 2)}\n`);
}

function canonical(dir: string, platform: NodeJS.Platform): string {
  let resolved = dir;
  try { resolved = fs.realpathSync(dir); } catch { /* compare the literal path */ }
  const p = platform === 'win32' ? path.win32 : path.posix;
  const normalized = p.normalize(resolved).replace(/[\\/]+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** The desktop app's private install: the server package lives in `<home>/runtime/prefix`. */
export function isManagedRuntimeInstall(home: string, installRoot: string, platform: NodeJS.Platform): boolean {
  const prefix = npmPrefixFromInstallRoot(installRoot, '@cortex-agent/server', platform);
  if (!prefix) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return canonical(prefix, platform) === canonical(p.join(home, 'runtime', 'prefix'), platform);
}
