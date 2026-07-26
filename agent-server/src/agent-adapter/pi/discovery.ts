// input:  PI CLI model table + session directory JSONL files
// output: discoverPIProviders + piSessionFileExists
// pos:    PI adapter provider/session discovery helpers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { execSync } from 'child_process';
import { closeSync, openSync, readdirSync, readSync } from 'fs';
import * as path from 'path';

import { parsePiListModelsOutput } from '@core/gateway-generator.js';
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

/** Check PI's filename fast path, then a bounded JSONL session-header prefix. */
export function piSessionFileExists(sessionDir: string, sessionId: string): boolean {
  if (!sessionId) return false;
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter((file) => file.endsWith('.jsonl'));
  } catch {
    return false;
  }
  if (files.some((file) => file.includes(sessionId))) return true;
  return files.some((file) => sessionHeaderMatches(path.join(sessionDir, file), sessionId));
}

function sessionHeaderMatches(filePath: string, sessionId: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString('utf8', 0, bytes).split('\n', 1)[0];
    const header = JSON.parse(firstLine) as Record<string, unknown>;
    return header.id === sessionId || header.sessionId === sessionId;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore close failure after a read attempt */ }
    }
  }
}
