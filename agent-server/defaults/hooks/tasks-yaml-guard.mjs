#!/usr/bin/env node
// @cortex-hook-version 2026.9.15-2
// input:  stdin JSON — Claude Code PreToolUse event payload
// output: stdout JSON — { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } }
// pos:    PreToolUse hook — intercepts Edit/Write on **/TASKS.yaml, checks project lock
//         allow when current process holds the lock; deny + helpful message otherwise
//         Owner identity: process.env.CORTEX_EXECUTION_ID ?? manual:<user>:<pid>
// >>> If I am updated, be sure to update my header comment and the AGENTS.md in the same folder <<<

import { readFileSync, existsSync } from 'fs';
import { basename, resolve } from 'path';
import { userInfo } from 'os';

// ── Constants ──

const TASKS_YAML = 'TASKS.yaml';
const TOOLS = new Set(['Edit', 'Write']);

// ── Helpers ──

/**
 * Get the current owner identity.
 * Priority: CORTEX_EXECUTION_ID env var > manual:<user>:<pid>
 */
function getOwnerIdentity() {
  if (process.env.CORTEX_EXECUTION_ID) return process.env.CORTEX_EXECUTION_ID;
  let user;
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER || 'unknown';
  }
  return `manual:${user}:${process.pid}`;
}

/**
 * Parse the `lock:` top-level field from a TASKS.yaml string.
 * Returns null if no lock section or if YAML is unparseable.
 *
 * Lock format:
 *   lock:
 *     owner: <string>
 *     acquired_at: <ISO string>
 *     expires_at: <ISO string>
 *     note?: <string>
 */
function parseLock(content) {
  const lines = content.split('\n');
  let inLock = false;
  let lockIndent = 0;
  const lock = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Detect top-level `lock:` key (at column 0)
    if (!inLock) {
      const lockMatch = trimmed.match(/^lock:\s*(.*)$/);
      if (lockMatch) {
        inLock = true;
        lockIndent = line.length - trimmed.length; // leading whitespace
        // If inline value after lock: (e.g. lock: null), skip
        if (lockMatch[1].trim() && lockMatch[1].trim() !== '') {
          // Inline value — not an object, so no lock
          return null;
        }
        continue;
      }
      continue;
    }

    // We're in the lock block. Check if this line is still part of it.
    const leadingSpace = line.length - line.trimStart().length;

    // Empty line — skip
    if (trimmed === '') continue;

    // Line at same or lesser indent than the `lock:` key → lock block is done
    if (leadingSpace <= lockIndent && line.trim()) {
      break;
    }

    // Parse key: value within lock block
    const kvMatch = trimmed.match(/^(\s*)([a-zA-Z_-]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[2];
      let value = kvMatch[3].trim();
      // Unquote strings
      value = value.replace(/^["']|["']$/g, '');
      lock[key] = value;
    }
  }

  // Validate required fields
  if (lock.owner && lock.acquired_at && lock.expires_at) {
    return { owner: lock.owner, acquired_at: lock.acquired_at, expires_at: lock.expires_at };
  }

  return null;
}

/**
 * Build a friendly deny message with cortex-task usage examples.
 */
function buildDenyMessage(lock, owner) {
  const lines = [
    'Direct Edit/Write of TASKS.yaml is not allowed without holding the project lock.',
    '',
  ];

  if (!lock) {
    lines.push('No lock is currently held on this TASKS.yaml.');
  } else {
    const expiresAt = new Date(lock.expires_at);
    if (expiresAt <= new Date()) {
      lines.push(`The lock expired at ${lock.expires_at}. The previous owner was: ${lock.owner}`);
    } else {
      lines.push(`Lock is held by: ${lock.owner} (current identity: ${owner})`);
    }
  }

  lines.push(
    '',
    'Use the cortex-task CLI to safely modify tasks:',
    '  cortex-task lock-acquire --project <project>     Acquire the project lock',
    '  cortex-task add --project <project>               Add a new task',
    '  cortex-task edit --project <project> --task-id <id>   Edit an existing task',
    '  cortex-task lock-release --project <project>      Release the lock when done',
    '',
    'The cortex-task CLI handles lock checking automatically.',
  );

  return lines.join('\n');
}

/**
 * Check lock state and return decision.
 */
function checkLock(absPath, owner) {
  let content;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    // File doesn't exist or can't be read — not our concern
    return null;
  }

  const lock = parseLock(content);

  // No lock → deny (with helpful message to acquire one)
  if (!lock) {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: buildDenyMessage(null, owner),
    };
  }

  // Check expiry
  const expiresAt = new Date(lock.expires_at);
  if (isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: buildDenyMessage(lock, owner),
    };
  }

  // Lock held by different owner
  if (lock.owner !== owner) {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: buildDenyMessage(lock, owner),
    };
  }

  // Lock held by current owner
  return {
    permissionDecision: 'allow',
    permissionDecisionReason: `Lock held by ${owner} (acquired ${lock.acquired_at}, expires ${lock.expires_at}) — proceed with edit.`,
  };
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

  // Only intercept Edit and Write tools
  const toolName = payload.tool_name;
  if (!TOOLS.has(toolName)) return;

  // Extract file path
  const toolInput = payload.tool_input || {};
  const filePath = toolInput.file_path || '';
  if (!filePath) return;

  const cwd = payload.cwd || process.cwd();
  const absPath = resolve(cwd, filePath);

  // Only guard TASKS.yaml files
  if (basename(absPath) !== TASKS_YAML) return;

  const owner = getOwnerIdentity();
  const decision = checkLock(absPath, owner);

  if (!decision) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.permissionDecision,
      permissionDecisionReason: decision.permissionDecisionReason,
    },
  }));
}

main();
