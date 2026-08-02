#!/usr/bin/env node
// @cortex-hook-version 2026.6.22-2
// input:  stdin { channel, sessionId, sessionName, trigger, timestampIso } + env CORTEX_HOOK_*
// output: stdout — prompt to inject into the closing session (empty stdout = skip)
// pos:    !new pre-close memory flush hook — recall valuable user and project info from the session, write to corresponding context files
// >>> If I am updated, be sure to update my header comment and the CORTEX.md in the same folder <<<

import { execSync } from 'child_process';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let ctx = {};
  try { ctx = JSON.parse(raw || '{}'); } catch {}

  let hasChanges = false;
  try {
    const out = execSync('git status --porcelain', { encoding: 'utf8', timeout: 10_000 }).trim();
    hasChanges = out.length > 0;
  } catch {}

  const prompt = `Before this session closes, do a memory flush. Think back through everything that happened in this session and persist anything a fresh session would need to know.

## User memory — USER.md (context/user/USER.md)

Is there anything new you learned about the user *personally*? USER.md is for the individual's preferences, identity, communication style, and working habits — NOT lab environment, project deadlines, or technical infrastructure (those belong in project context below).

Examples of what to record:
- "Prefers Chinese for discussion, English for code/paper"
- "Likes to review all changes before they're committed"
- "Dislikes long docstrings — prefers single-line comments at call sites"
- "Uses two-space indentation in all projects"
- "Prefers to be addressed as 'Alex' rather than 'Taylor'"

Non-examples (do NOT record — these are project/lab context, not personal):
- Deadlines ("Conference 2026 submission due [date]") → goes to project context
- Lab setup ("uses ROS 2 Humble on Ubuntu 22.04") → goes to project context
- Technical tools ("uses Weights & Biases") → goes to project context
- Transient facts ("asked me to run ls in /tmp")
- One-off requests unlikely to recur
- Information already present in USER.md

If you find something, use the /user-learn skill or directly edit USER.md. Respect the 3KB hard limit — compress rather than grow if near the limit. The file has YAML frontmatter (last-updated, updated-by, size-limit) — update those fields.

## Project context — STATUS.md, knowledge/K-NNN.md, ISSUES.md

Did this session produce findings, decisions, or changes that future sessions need to know? Did you discover the location of external resources?

Examples of what to record:
- A new experiment was launched → update STATUS.md with what's running
- A non-obvious fact was discovered ("the dataset is on gpu-server at /data/xxx") → create a K-NNN.md entry so it's indexed
- External resource locations → "The paper source is at ~/papers/conference2026/", "Training data lives on gpu-server:/datasets/dataset-v3/", "Reference implementation at https://github.com/xxx/yyy" — record as a knowledge entry (K-NNN); durable facts do not go in STATUS.md
- A recurring friction was encountered ("the GPU on local always OOMs with batch_size > 32") → append to ISSUES.md
- A design decision was made → add to decisions/ directory
- A new project dependency or constraint was discovered → update STATUS.md

File update rules you MUST respect:
- **STATUS.md** — state register (hard cap 80 lines AND 6KB): replace stale lines with the latest state, never append; one line + pointer per change, details live in EXP/K/tasks-archive; adding a line requires checking which old lines expired
- **ISSUES.md** — append mode: add new entries at the end, keep history
- **knowledge/K-NNN.md** — atomic: one file per knowledge entry, with YAML frontmatter
- **knowledge/index.md, experiments/index.md, patterns/index.md** — AUTO-GENERATED, do NOT edit manually
- **mission.md** — requires user approval to modify
- **roadmap.md** — stable, only update checklist items that were verified this session
- **TASKS.yaml** — use cortex-task CLI, do not hand-edit

Do NOT create files for trivial observations. Only persist what a fresh session would genuinely need.

## After recording

- Run \`git status\` to review all changes
- Commit context file changes with a clear, specific message (e.g. "context: record gpu-server dataset path and Conference deadline")
- Do NOT commit changes you did not make`;

  if (hasChanges) {
    process.stdout.write(prompt + '\n\nNote: there are already uncommitted changes in the repo from earlier work — only commit your own changes, leave the rest alone.');
  } else {
    process.stdout.write(prompt);
  }
}

main().catch((err) => {
  process.stderr.write(`[new-session-hook] ${err?.message || err}\n`);
  process.exit(1);
});
