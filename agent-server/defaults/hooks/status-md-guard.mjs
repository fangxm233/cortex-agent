#!/usr/bin/env node
// @cortex-hook-version 2026.8.2
// input:  stdin JSON — Claude Code PreToolUse event payload
// output: stdout JSON — { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason }, systemMessage? }
// pos:    PreToolUse hook — intercepts Edit/Write on size-capped context files and
//         enforces their caps (limit table below; rules/status-md.md, rules/issues-md.md,
//         rules/cortex-md.md): deny writes whose result exceeds the caps, unless the
//         write shrinks an already-over-limit file (so cleanup stays possible); warn
//         when approaching the cap. Guarded files:
//           context/projects/<p>/STATUS.md — 80 lines / 6KB (state register)
//           context/projects/<p>/ISSUES.md — 80 lines / 6KB (friction log)
//           CORTEX.md anywhere under a context/ tree — 120 lines / 8KB (injected index)
// >>> If I am updated, be sure to update my header comment and the CORTEX.md in the same folder <<<

import { readFileSync, existsSync } from 'fs';
import { resolve, sep } from 'path';

// ── Constants ──

const TOOLS = new Set(['Edit', 'Write']);

/** .../context/projects/<name>/<file> */
function isProjectRootFile(parts, fileName) {
  if (parts[parts.length - 1] !== fileName) return false;
  const projectsIdx = parts.length - 3;
  const contextIdx = parts.length - 4;
  return projectsIdx > 0 && parts[projectsIdx] === 'projects' && parts[contextIdx] === 'context';
}

const LIMIT_RULES = [
  {
    name: 'STATUS.md',
    ruleFile: 'rules/status-md.md',
    matches: (parts) => isProjectRootFile(parts, 'STATUS.md'),
    maxLines: 80,
    maxBytes: 6 * 1024,
    warnLines: 60,
    warnBytes: 4 * 1024,
    capLabel: '80 lines AND 6KB',
    trimAdvice: [
      'STATUS is a state register, not a changelog. Trim before writing:',
      '- delete entries that no longer affect decisions (their content already lives in tasks-archive / git / EXP records),',
      '- compress each bullet to one line + pointer (task-id / EXP-NNN / K-NNN / DR-NNNN / commit SHA),',
      '- move completion reports to the task note, durable facts to knowledge entries, verdict analysis to the gate artifact.',
    ],
  },
  {
    name: 'ISSUES.md',
    ruleFile: 'rules/issues-md.md',
    matches: (parts) => isProjectRootFile(parts, 'ISSUES.md'),
    maxLines: 80,
    maxBytes: 6 * 1024,
    warnLines: 60,
    warnBytes: 4 * 1024,
    capLabel: '80 lines AND 6KB',
    trimAdvice: [
      'ISSUES.md is a friction log with <=4-line entries. Trim before writing:',
      '- delete resolved entries outright (no changelog),',
      '- compress each entry to symptom + one-line root cause + pointer (K-NNN / task artifact / EXP-NNN / file:line),',
      '- merge same-cause frictions into one entry.',
    ],
  },
  {
    name: 'CORTEX.md',
    ruleFile: 'rules/cortex-md.md',
    matches: (parts) => parts[parts.length - 1] === 'CORTEX.md' && parts.includes('context'),
    maxLines: 120,
    maxBytes: 8 * 1024,
    warnLines: 90,
    warnBytes: 6656,
    capLabel: '120 lines AND 8KB',
    trimAdvice: [
      'CORTEX.md is an injected index (truncated at 9500 chars): it answers "what is here, where to look", not the content itself. Trim before writing:',
      '- collapse atomic directories (experiments/ knowledge/ patterns/ decisions/) to one line each pointing at their index.md,',
      '- entry summaries already live in the atomic files and their auto-generated index.md — never duplicate them here,',
      '- keep each index line to one sentence + pointer (<=200 chars).',
    ],
  },
];

// ── Helpers ──

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

function denyReason(rule, lineCount, byteCount) {
  return [
    `${rule.name} write rejected: the result would be ${lineCount} lines / ${byteCount} bytes — the hard cap is ${rule.capLabel} (${rule.ruleFile}).`,
    '',
    ...rule.trimAdvice,
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
  const parts = resolve(cwd, filePath).split(sep);
  const rule = LIMIT_RULES.find((r) => r.matches(parts));
  if (!rule) return;

  const absPath = resolve(cwd, filePath);
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

  if (lineCount > rule.maxLines || byteCount > rule.maxBytes) {
    // Shrink exception: an over-limit file may be reduced step by step.
    if (currentBytes !== null && byteCount < currentBytes) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `Still over the ${rule.name} cap (${lineCount} lines / ${byteCount} bytes > ${rule.capLabel}) but shrinking — keep trimming to within the limit.`,
        },
        systemMessage: `${rule.name} is still over the ${rule.capLabel} cap (${lineCount} lines / ${byteCount} bytes). This write shrinks it and is allowed — keep trimming.`,
      }));
      return;
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason(rule, lineCount, byteCount),
      },
    }));
    return;
  }

  if (lineCount >= rule.warnLines || byteCount >= rule.warnBytes) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `${rule.name} approaching its cap (${lineCount} lines / ${byteCount} bytes; hard cap ${rule.capLabel}) — trim proactively.`,
      },
      systemMessage: `${rule.name} is approaching its cap (${lineCount} lines / ${byteCount} bytes; hard cap ${rule.capLabel}). Trim proactively (${rule.ruleFile}).`,
    }));
  }
}

main();
