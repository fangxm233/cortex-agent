import { readdir } from 'node:fs/promises';
import * as path from 'path';
import { AGENT_CWD, CLAUDE_CONFIG_HOME, DATA_DIR } from '@core/paths.js';
import { selectPISessionFilename } from '@core/pi-session-filename.js';
import { anchorAtEnd } from '@core/transcript-anchor.js';
import type { TurnAnchor } from '@core/types/transcript-anchor.js';

/**
 * The Claude Code project directory for a session's cwd (`sessionSpawnCwd`), inside Cortex's own
 * Claude config dir. Claude Code encodes project directories by replacing '/' and '.' with '-'.
 * e.g. /home/user/.cortex → -home-user--cortex
 */
function getProjectDir(cwd: string = AGENT_CWD): string {
  return path.join(CLAUDE_CONFIG_HOME, 'projects', path.resolve(cwd).replace(/[\/.]/g, '-'));
}

/** The Claude Code transcript of a session that runs in `cwd`. */
function getSessionFilePath(sessionId: string, cwd?: string): string {
  return path.join(getProjectDir(cwd), `${sessionId}.jsonl`);
}

/** PI session directory (matches agent-adapter/pi/agent-dir.ts). */
const PI_SESSIONS_DIR = path.join(DATA_DIR, 'logs', 'sessions-pi');

/** Find a PI transcript from its exact id-bearing filename without opening JSONL bodies. */
async function findPISessionFile(
  sessionId: string,
  sessionDir: string = PI_SESSIONS_DIR,
): Promise<string | null> {
  try {
    const filename = selectPISessionFilename(await readdir(sessionDir), sessionId);
    return filename ? path.join(sessionDir, filename) : null;
  } catch {
    return null;
  }
}

/** The transcript backend session `backendSessionId` writes; `cwd` locates a Claude one. */
async function transcriptFile(backend: string, backendSessionId: string, cwd?: string): Promise<string | null> {
  return backend === 'pi' ? findPISessionFile(backendSessionId) : getSessionFilePath(backendSessionId, cwd);
}

/** An anchor at the current end of the backend session's transcript; null when it has none yet. */
async function anchorTranscriptEnd(backend: string, backendSessionId: string, cwd?: string): Promise<TurnAnchor | null> {
  const file = await transcriptFile(backend, backendSessionId, cwd);
  return file ? anchorAtEnd(file) : null;
}

export {
  getProjectDir,
  getSessionFilePath,
  findPISessionFile,
  transcriptFile,
  anchorTranscriptEnd,
};
