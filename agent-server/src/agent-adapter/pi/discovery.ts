// input:  PI model table and session filenames
// output: provider list and filename session lookup
// pos:    PI provider and resume-target discovery
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import * as path from 'path';

import { parsePiListModelsOutput } from '@core/gateway-generator.js';
import { selectPISessionFilename } from '@core/pi-session-filename.js';
import { createLogger } from '@core/log.js';

const log = createLogger('pi-adapter');

/** Discover authenticated PI providers without inheriting Cortex's private agent directory. */
export function discoverPIProviders(): string[] {
  try {
    const stdout = execSync('pi --list-models 2>&1', {
      timeout: 10_000,
      encoding: 'utf-8',
      env: { ...process.env, PI_CODING_AGENT_DIR: '' },
    });
    const providers = new Set(parsePiListModelsOutput(stdout).map((model) => model.provider));
    return Array.from(providers);
  } catch (err) {
    log.info(`pi --list-models failed at spawn: ${(err as Error).message ?? 'unknown'}`);
    return [];
  }
}

/** Resolve PI's exact id-bearing filename without opening transcript bodies. */
export function findPISessionFilePath(sessionDir: string, sessionId: string): string | null {
  if (!sessionId) return null;
  try {
    const filename = selectPISessionFilename(readdirSync(sessionDir), sessionId);
    return filename ? path.join(sessionDir, filename) : null;
  } catch {
    return null;
  }
}
