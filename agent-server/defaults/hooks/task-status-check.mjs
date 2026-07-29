#!/usr/bin/env node
// @cortex-hook-version 2026.7.29
// input:  stdin thread lifecycle payload, argv identity fallback
// output: HookResult for unresolved dispatch task state
// pos:    Checks task status after a dispatched thread terminates
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { readFileSync, existsSync, readdirSync } from 'fs';
import * as path from 'path';
import { homedir } from 'os';

const DATA_DIR = process.env.CORTEX_HOME
  ? path.resolve(process.env.CORTEX_HOME)
  : path.join(homedir(), '.cortex');
const PROJECTS_DIR = process.env.CORTEX_PROJECTS_DIR
  ? path.resolve(process.env.CORTEX_PROJECTS_DIR)
  : path.join(DATA_DIR, 'context', 'projects');

const CORTEX_RUN_DIR = path.join(DATA_DIR, 'tmp', 'cortex-run');

function noop() {
  console.log(JSON.stringify({ insertAgent: false }));
}

/**
 * Parse a single TASKS.yaml task block into an object.
 * A task block starts with "  - id:" and spans until the next "  - id:" or EOF.
 * We only extract fields we care about: id, status, claimed-by, blocked-by.
 */
function findTaskById(content, taskId) {
  const lines = content.split('\n');
  let inBlock = false;
  let blockStart = -1;

  // Find the task block containing our taskId
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = line.match(/^\s+- id:\s*(.+)$/);
    if (idMatch) {
      // Extract the ID value (handle both quoted and unquoted)
      const thisId = idMatch[1].trim().replace(/^["']|["']$/g, '');
      if (thisId === taskId) {
        inBlock = true;
        blockStart = i;
      } else if (inBlock) {
        // We were in our block but hit the next task — stop
        break;
      }
    } else if (inBlock && /^\s+- id:/.test(line)) {
      // Fallback: next task block starts
      break;
    }
  }

  if (blockStart === -1) return null;

  // Parse fields from the task block
  const task = { id: taskId };
  for (let i = blockStart + 1; i < lines.length; i++) {
    const line = lines[i];
    // Stop at next top-level key or next task
    if (/^\S/.test(line) && !/^\s/.test(line)) break;
    if (/^\s+- id:/.test(line)) break;

    const fieldMatch = line.match(/^\s{4,}([a-zA-Z_-]+):\s*(.*)$/);
    if (fieldMatch) {
      const key = fieldMatch[1];
      let value = fieldMatch[2].trim();
      // Unquote string values
      value = value.replace(/^["']|["']$/g, '');
      // Handle boolean/null
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (value === 'null' || value === '') value = null;
      task[key] = value;
    }
  }

  return task;
}

/** Find a cortex-run state file that references the given task. */
function findStateFileForTask(project, taskId) {
  try {
    if (!existsSync(CORTEX_RUN_DIR)) return null;
    for (const entry of readdirSync(CORTEX_RUN_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statePath = path.join(CORTEX_RUN_DIR, entry.name, 'state.json');
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        if (state.task_project === project && state.task_id === taskId) {
          return { runName: entry.name, ...state };
        }
      } catch {}
    }
  } catch {}
  return null;
}

/** Check if a PID is still alive. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const ctx = input.trim() ? JSON.parse(input) : {};
  const [argvProject, argvTaskId] = process.argv.slice(2);
  const payloadProject = ctx.project ?? ctx.taskProject ?? ctx.projectId;
  const project = typeof payloadProject === 'string' && payloadProject ? payloadProject : argvProject;
  const taskId = typeof ctx.taskId === 'string' && ctx.taskId ? ctx.taskId : argvTaskId;

  if (!project || !taskId) { noop(); return; }

  // Out-of-band control intent (DR-0015): the agent signalled abort/split/wait via a tool, not
  // by writing a marker into the artifact. Read the typed signal — never scan the artifact (prose
  // mentioning "[ABORT]"/"[SPLIT]" must not trip this).
  //  - split: the task is INTENTIONALLY not done — the dispatcher decomposes it keep-parent and
  //    unclaims right after this hook returns. Don't burn an agent turn nagging. (The runner
  //    leaves pendingControl set for the dispatch path, so it is still present here.)
  //  - abort: the runner already blocked the task BEFORE this hook (DR-0015 problem 2) and cleared
  //    the control, so the blocked-by guard below covers it; this is belt-and-suspenders.
  if (ctx.pendingControlAction === 'split' || ctx.pendingControlAction === 'abort') { noop(); return; }

  const tasksPath = path.join(PROJECTS_DIR, project, 'TASKS.yaml');
  if (!existsSync(tasksPath)) { noop(); return; }

  let content;
  try {
    content = readFileSync(tasksPath, 'utf8');
  } catch {
    noop();
    return;
  }

  const task = findTaskById(content, taskId);
  if (!task) { noop(); return; }

  // Task is done — nothing to do.
  if (task.status === 'done') { noop(); return; }

  // Task is pending — cortex-run is handling it. No recovery; just verify.
  if (task.status === 'pending') {
    const stateFile = findStateFileForTask(project, taskId);
    if (!stateFile || stateFile.status === 'failed') {
      // cortex-run state file missing or run failed — but per design, do not auto-recover.
      // Just report so it's visible.
      const targetAgent = ctx.previousAgent;
      if (targetAgent) {
        const note = !stateFile
          ? 'no state file found (cortex-run may not have started)'
          : `state file shows status=${stateFile.status} (exit ${stateFile.exit_code})`;
        console.log(JSON.stringify({
          insertAgent: false,
          targetAgent,
          prompt: [
            `FYI: task [id: ${taskId}] in project "${project}" is still [pending] but cortex-run ${note}.`,
            'Per current policy, pending→done recovery is not automatic. Check manually if needed.',
          ].join('\n'),
        }));
        return;
      }
    }
    noop();
    return;
  }

  // Task is blocked — nothing to do.
  if (task['blocked-by']) { noop(); return; }

  // Task is still claimed — thread ended but task not transitioned.
  if (task['claimed-by']) {
    const targetAgent = ctx.previousAgent;
    if (!targetAgent) { noop(); return; }

    // Check if there's a cortex-run process handling this task
    const stateFile = findStateFileForTask(project, taskId);

    if (stateFile && stateFile.status === 'running') {
      // cortex-run is running — this is a legitimate pending case.
      // Engineer forgot to call cortex-task pending; auto-transition.
      console.log(JSON.stringify({
        insertAgent: false,
        targetAgent,
        prompt: [
          `Auto-detected: task [id: ${taskId}] in project "${project}" is still claimed,`,
          `but a cortex-run process "(${stateFile.runName})" is running for this task (PID ${stateFile.pid}).`,
          `The engineer likely forgot to mark the task pending. Call:`,
          `  cortex-task pending --project ${project} --task-id ${taskId}`,
        ].join('\n'),
      }));
      return;
    }

    // No cortex-run state file — genuine orphan.
    // Unclaim and prompt agent to resolve.
    console.log(JSON.stringify({
      insertAgent: false,
      targetAgent,
      prompt: [
        `Status check: task [id: ${taskId}] in project "${project}" is still marked [claimed] in TASKS.yaml, but the thread has finished. No running cortex-run process found for this task.`,
        '',
        'Resolve the task status now — do not leave it in limbo:',
        `- If done-when conditions are satisfied: cortex-task complete --project ${project} --task-id ${taskId} --note "<what you did>"`,
        `- If blocked by external reasons: cortex-task block --project ${project} --task-id ${taskId} --reason "<reason>"`,
        `- If a cortex-run is still running: cortex-task pending --project ${project} --task-id ${taskId}`,
        `- If none of the above apply: cortex-task unclaim --project ${project} --task-id ${taskId}`,
        '',
        'After updating the task, commit the TASKS.yaml change.',
      ].join('\n'),
    }));
    return;
  }

  noop();
}

main().catch((err) => {
  console.error(`[task-status-check] Fatal: ${err.message}`);
  console.log(JSON.stringify({ insertAgent: false }));
});
