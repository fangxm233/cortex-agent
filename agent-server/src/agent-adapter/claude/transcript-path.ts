// input:  Cwd, sessionId, injected filesystem probe
// output: Claude jsonl transcript path and the --resume-vs-create decision
// pos:    Shared by print-mode resume gating (survived the D9 TUI retirement)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { existsSync } from 'node:fs';
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
