#!/usr/bin/env node
// @cortex-hook-version 2026.8.2
// input:  stdin JSON — Claude Code PreToolUse event payload
// output: stdout JSON — { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason }, systemMessage? }
// pos:    PreToolUse hook — intercepts Edit/Write on context/projects/*/STATUS.md and
//         enforces the state-register size caps (80 lines AND 6KB, rules/status-md.md):
//         deny writes whose result exceeds the caps, unless the write shrinks an
//         already-over-limit file (so cleanup stays possible); warn at 60 lines / 4KB.
// >>> If I am updated, be sure to update my header comment and the CORTEX.md in the same folder <<<

import { readFileSync, existsSync } from 'fs';
import { resolve, sep } from 'path';

// ── Constants ──

const TOOLS = new Set(['Edit', 'Write']);
const MAX_LINES = 80;
const MAX_BYTES = 6 * 1024;
const WARN_LINES = 60;
const WARN_BYTES = 4 * 1024;

// ── Helpers ──

/** Only guard the project register files: .../context/projects/<name>/STATUS.md */
function isProjectStatusPath(absPath) {
  const parts = absPath.split(sep);
  if (parts[parts.length - 1] !== 'STATUS.md') return false;
  const projectsIdx = parts.length - 3;
  const contextIdx = parts.length - 4;
  return projectsIdx > 0 && parts[projectsIdx] === 'projects' && parts[contextIdx] === 'context';
}

function countLines(content) {
  if (content === '') return 0;
  const chunks = content.split('\n');
  return chunks[chunks.length - 1] === '' ? chunks.length - 1 : chunks.length;
}

/** Compute the content the tool call would leave on disk, or null when indeterminable. */
function proposedContent(toolName, toolInput, currentContent) {
  if (toolName === 'Write') return typeof toolInput.content === 'string' ? toolInput.content : null;
  // Edit
  const oldString = toolInput.old_string;
  const newString = toolInput.new_string;
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
  if (currentContent === null || !currentContent.includes(oldString)) return null; // tool will fail on its own
  return toolInput.replace_all
    ? currentContent.split(oldString).join(newString)
    : currentContent.replace(oldString, newString);
}

function denyReason(lineCount, byteCount) {
  return [
    `STATUS.md write rejected: the result would be ${lineCount} lines / ${byteCount} bytes — the hard cap is 80 lines AND 6KB (rules/status-md.md).`,
    '',
    'STATUS is a state register, not a changelog. Trim before writing:',
    '- delete entries that no longer affect decisions (their content already lives in tasks-archive / git / EXP records),',
    '- compress each bullet to one line + pointer (task-id / EXP-NNN / K-NNN / DR-NNNN / commit SHA),',
    '- move completion reports to the task note, durable facts to knowledge entries, verdict analysis to the gate artifact.',
    '',
    'Writes that shrink an already-over-limit file are allowed — reduce the size, then write.',
  ].join('\n');
}

// ── Main ──

function main() {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    return;
  }
  if (!input.trim()) return;

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  if (!TOOLS.has(payload.tool_name)) return;

  const toolInput = payload.tool_input || {};
  const filePath = toolInput.file_path || '';
  if (!filePath) return;

  const cwd = payload.cwd || process.cwd();
  const absPath = resolve(cwd, filePath);
  if (!isProjectStatusPath(absPath)) return;

  let currentContent = null;
  if (existsSync(absPath)) {
    try {
      currentContent = readFileSync(absPath, 'utf8');
    } catch {
      return;
    }
  }

  const proposed = proposedContent(payload.tool_name, toolInput, currentContent);
  if (proposed === null) return;

  const lineCount = countLines(proposed);
  const byteCount = Buffer.byteLength(proposed, 'utf8');
  const currentBytes = currentContent === null ? null : Buffer.byteLength(currentContent, 'utf8');

  if (lineCount > MAX_LINES || byteCount > MAX_BYTES) {
    // Shrink exception: an over-limit file may be reduced step by step.
    if (currentBytes !== null && byteCount < currentBytes) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `Still over the STATUS.md cap (${lineCount} lines / ${byteCount} bytes > 80 lines / 6KB) but shrinking — keep trimming to within the limit.`,
        },
        systemMessage: `STATUS.md is still over the 80-line/6KB cap (${lineCount} lines / ${byteCount} bytes). This write shrinks it and is allowed — keep trimming.`,
      }));
      return;
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason(lineCount, byteCount),
      },
    }));
    return;
  }

  if (lineCount >= WARN_LINES || byteCount >= WARN_BYTES) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `STATUS.md approaching its cap (${lineCount} lines / ${byteCount} bytes; hard cap 80 lines / 6KB) — trim proactively.`,
      },
      systemMessage: `STATUS.md is approaching its cap (${lineCount} lines / ${byteCount} bytes; hard cap 80 lines AND 6KB). Trim proactively: delete entries that no longer affect decisions (rules/status-md.md).`,
    }));
  }
}

main();
