import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import * as path from 'path';
import { TUI_JSONL_BASE } from './defaults.js';

/**
 * Mirror Claude Code's convention: the jsonl session transcript lives at
 *   ~/.claude/projects/<dash-encoded-cwd>/<sessionId>.jsonl
 * where dash-encoded-cwd is the absolute cwd with BOTH `/` AND `.` replaced by `-`
 * (leading slash → leading `-`; dotfiles like `.cortex` → `--cortex`).
 *
 * Empirically verified against `~/.claude/projects/` directory contents on Claude 2.1.141+:
 *   `/home/alice/.cortex`       → `-home-alice--cortex`
 *   `/srv/cortex/workspace`     → `-srv-cortex-workspace`
 *   `/tmp/cortex-spike-tui`     → `-tmp-cortex-spike-tui`
 *
 * The original spike ran in `/tmp/cortex-spike-tui` (no dots), so the dot-encoding rule was
 * missed initially — without it, sessions under `~/.cortex/` (the default DATA_DIR) would
 * have watched a non-existent transcript path.
 */
export function computeTranscriptPath(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/[/.]/g, '-');
  return path.join(TUI_JSONL_BASE, encoded, `${sessionId}.jsonl`);
}

/**
 * Decide whether a session should spawn with `--resume <id>` (vs `--session-id <id>`).
 *
 * `--resume` only succeeds when a Claude transcript already exists for that id. A *fresh*
 * session pre-registers its channel→sessionId mapping BEFORE the first Claude turn (so transcript
 * replay / session naming work), which makes the orchestrator's generic "a session mapping exists
 * ⇒ resume" heuristic ask to resume an id that has no transcript yet — Claude then exits with
 * "No conversation found with session ID: <id>". Gating the resume request on the transcript
 * actually existing keeps the first turn on `--session-id` (create) and lets only later turns /
 * reconnects use `--resume`. Self-healing: a deleted transcript also correctly falls back to create.
 */
export function resolveResumeAgainstTranscript(
  requestedResume: boolean,
  transcriptPath: string,
  exists: (p: string) => boolean = existsSync,
): boolean {
  return requestedResume && exists(transcriptPath);
}

const COST_STATE_NEEDLE = Buffer.from('"cost-state"');
const TAIL_CHUNK_BYTES = 1 << 20;

function costStateValue(line: string, sessionId: string): number | null {
  let entry: { type?: unknown; sessionId?: unknown; totalCostUSD?: unknown };
  try { entry = JSON.parse(line); } catch { return null; }
  const value = entry.totalCostUSD;
  if (entry.type !== 'cost-state' || entry.sessionId !== sessionId) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The last matching cost-state among the complete lines of `buf`, scanning from the end. */
function lastCostStateIn(buf: Buffer, sessionId: string): number | null {
  let hit = buf.lastIndexOf(COST_STATE_NEEDLE);
  while (hit !== -1) {
    const lineStart = buf.lastIndexOf(0x0a, hit) + 1;
    const newline = buf.indexOf(0x0a, hit);
    const value = costStateValue(buf.toString('utf8', lineStart, newline === -1 ? buf.length : newline), sessionId);
    if (value !== null) return value;
    if (lineStart === 0) return null;
    hit = buf.lastIndexOf(COST_STATE_NEEDLE, lineStart - 1);
  }
  return null;
}

/**
 * The running cost Claude will restore when it resumes `sessionId`.
 *
 * The CLI appends a `cost-state` entry (lifetime `totalCostUSD` of the session) to the transcript
 * when a process exits, and `--resume` restores the last one, so a resumed process's first
 * `total_cost_usd` already includes every earlier process's spend. Returns 0 when the transcript
 * holds no such entry (new session, or a CLI that does not persist cost). Reads from the end in
 * chunks: the entry sits right after the previous process's last turn.
 */
export function readRestoredSessionCost(
  transcriptPath: string,
  sessionId: string,
  chunkBytes: number = TAIL_CHUNK_BYTES,
): number {
  let fd: number;
  try { fd = openSync(transcriptPath, 'r'); } catch { return 0; }
  try {
    let end = fstatSync(fd).size;
    // The leading partial line of the chunk read last, completed by the chunk before it.
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      const firstNewline = start === 0 ? -1 : buf.indexOf(0x0a);
      if (start > 0 && firstNewline === -1) { carry = buf; end = start; continue; }
      const value = lastCostStateIn(buf.subarray(firstNewline + 1), sessionId);
      if (value !== null) return value;
      carry = buf.subarray(0, Math.max(firstNewline, 0));
      end = start;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    closeSync(fd);
  }
}
