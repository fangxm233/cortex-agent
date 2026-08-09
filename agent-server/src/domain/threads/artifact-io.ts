// input:  thread store, session-activity JSONL
// output: Artifact I/O and modified-file path lookup
// pos:    Thread artifact and activity-log filesystem helpers
// >>> If I am updated, update my header comment and parent CORTEX.md <<<

import { readFileSync, rmSync, existsSync } from 'fs';
import * as path from 'path';
import { DATA_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { threadStore as daemonThreadStore } from '@store/thread-repo.js';
import {
  getLocalThreadRuntimeDeps, scopedLocalThreadService,
} from './local-runtime-deps.js';

const log = createLogger('artifact-io');
const threadStore = scopedLocalThreadService(daemonThreadStore, deps => deps.threadStore);

interface MutationRecord {
  event: 'edit_file' | 'write_file';
  file_path: string;
}

function sessionLogPath(sessionId: string): string {
  return path.join(DATA_DIR, 'logs', 'session-activity', `${sessionId}.jsonl`);
}

function readMutationRecords(sessionId: string | null | undefined): MutationRecord[] {
  if (!sessionId) return [];
  const logPath = sessionLogPath(sessionId);
  if (!existsSync(logPath)) return [];
  let content: string;
  try { content = readFileSync(logPath, 'utf8'); } catch { return []; }
  if (!content.trim()) return [];
  const out: MutationRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if ((record.event === 'edit_file' || record.event === 'write_file')
          && typeof record.file_path === 'string' && record.file_path.trim()) {
        out.push(record as MutationRecord);
      }
    } catch { continue; }
  }
  return out;
}

/** Return unique file paths modified during a session, ordered by first touch. */
export function getModifiedFilesFromSession(sessionId: string | null | undefined): string[] {
  if (getLocalThreadRuntimeDeps()?.portScope === 'fail-closed') return [];
  const records = readMutationRecords(sessionId);
  const files = new Set(records.map((record) => record.file_path.trim()));
  return [...files];
}

/** Read the artifact file content for a thread. */
export function readArtifact(threadId: string): string | null {
  const thread = threadStore.get(threadId);
  if (!thread?.artifactPath) return null;
  try {
    return readFileSync(thread.artifactPath, 'utf8');
  } catch {
    return null;
  }
}

/** Remove the workspace directory for a thread. */
export function cleanupWorkspace(threadId: string): void {
  const thread = threadStore.get(threadId);
  if (!thread?.workspacePath) return;
  try {
    rmSync(thread.workspacePath, { recursive: true, force: true });
    log.info(`Cleaned up workspace for ${threadId}`);
  } catch (e: any) {
    log.error(`Failed to cleanup workspace for ${threadId}: ${e.message}`);
  }
}
