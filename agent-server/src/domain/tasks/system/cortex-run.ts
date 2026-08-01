#!/usr/bin/env node
// input:  task lifecycle, daemon webhook, process environment
// output: remote launch/cancel CLI with dispatch generation metadata
// pos:    Dispatches cortex-run work through the daemon
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// cortex-run CLI dispatch via sendCommand (DR-0011 §4.8 + §4.9).
//
// Launch:
//     cortex-run [--device <name>] --name <name> [--stall 10m] [--gpu auto]
//                [--task-project P --task-id ABCD] [--force]
//                [--env-passthrough VAR1,VAR2,...]
//                [--log-tail-bytes 5000]
//                -- COMMAND [ARGS...]
//
// Cancel:
//     cortex-run --cancel <name> [--device <name>] [--signal SIGTERM]
//
// No local spawn — all execution forwarded via sendCommand to cortex-client.

import { getLocalMachine } from '@domain/tasks/dispatch-utils.js';
import { pendingTask } from './task-state.js';
import { parseArgs } from 'node:util';
import { isMainModule } from '@core/utils.js';

// --- Daemon webhook bridge (HTTP to agent-server daemon) ---
// The daemon's webhook server runs at 127.0.0.1:3001 (env WEBHOOK_PORT).
// When cortex-run runs standalone, the client-manager's devices Map lives in
// the daemon process, so we proxy sendCommand/isDeviceOnline through HTTP.

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3001', 10);
const WEBHOOK_BASE = `http://127.0.0.1:${WEBHOOK_PORT}`;
// Bearer token for the webhook auth gate. Inherited from the daemon/dispatcher env (see core/auth.ts).
const webhookAuthHeader = (): Record<string, string> => ({ 'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN || '' });

async function httpIsDeviceOnline(device: string): Promise<boolean> {
  try {
    const res = await fetch(`${WEBHOOK_BASE}/webhook/devices`, { headers: webhookAuthHeader() });
    if (!res.ok) return false;
    const data = (await res.json()) as { devices?: string[] };
    return data.devices?.includes(device) ?? false;
  } catch {
    return false;
  }
}

function isConnectionRefused(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as Record<string, any>;
    if (e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED') return true;
  }
  return false;
}

async function httpSendCommand(
  device: string,
  command: { action: string; params: Record<string, any>; timeout?: number },
): Promise<any> {
  const httpTimeout = (command.timeout || 60_000) + 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), httpTimeout);

  try {
    const res = await fetch(`${WEBHOOK_BASE}/webhook/remote-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...webhookAuthHeader() },
      body: JSON.stringify({
        device,
        action: command.action,
        params: command.params,
        timeout: command.timeout,
      }),
      signal: controller.signal,
    });

    const data = (await res.json()) as {
      success: boolean; data?: any; error?: string; onlineDevices?: string[];
    };

    if (!data.success) {
      const suffix = data.onlineDevices?.length
        ? ` Online devices: ${data.onlineDevices.join(', ')}`
        : '';
      throw new Error(`${data.error || 'Unknown error from daemon'}${suffix}`);
    }

    return data.data;
  } catch (e: any) {
    if (isConnectionRefused(e)) {
      throw new Error(
        `Cannot connect to cortex daemon at ${WEBHOOK_BASE}. Is the agent server running?`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// --- Types ---

function resolveTaskGeneration(
  project: string | null, taskId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const sameTask = !!taskId && env.CORTEX_TASK_ID === taskId;
  const sameProject = !!project && env.CORTEX_TASK_PROJECT === project;
  return sameTask && sameProject ? env.CORTEX_TASK_GENERATION ?? null : null;
}

interface CortexRunArgs {
  name?: string;
  device: string;
  command?: string[];
  project: string | null;
  taskId: string | null;
  envPassthrough: string[];
  logTailBytes: number;
  cancel: string | null;
  signal: string;
  stall: string;
  gpu: string;
  force: boolean;
}

// --- CLI parsing ---

function getCortexRunHelp(): string {
  return [
    'cortex-run — dispatch a command on a remote device via the Cortex daemon',
    '',
    'Launch:',
    '  cortex-run [--device <name>] --name <name> [--stall 10m] [--gpu auto]',
    '             [--task-project P --task-id ABCD] [--force]',
    '             [--env-passthrough VAR1,VAR2,...]',
    '             [--log-tail-bytes 5000]',
    '             -- COMMAND [ARGS...]',
    '',
    'Cancel:',
    '  cortex-run --cancel <name> [--device <name>] [--signal SIGTERM]',
    '',
    'Options:',
    '  --name <name>             Required for launch — unique run name (also used as result dir)',
    '  --device <name>           Target device (default: local machine name from machines.json)',
    '  --stall <duration>        Stall timeout, e.g. 10m / 1h (default: 10m)',
    '  --gpu <slot>              GPU slot: auto | none | <index> (default: auto)',
    '  --force                   Allow launch even if a same-name run state dir exists',
    '  --task-project <name>     Link this run to a TASKS.yaml task — marks pending on launch',
    '  --task-id <hash>          4-char hex task id (used with --task-project)',
    '  --env-passthrough <list>  Comma-separated env var names to forward to the remote',
    '  --log-tail-bytes <n>      Bytes of log tail returned in callback (default: 5000)',
    '  --cancel <name>           Cancel a previously launched run by name',
    '  --signal <sig>            Signal to send when cancelling (default: SIGTERM)',
    '  --help, -h                Show this help',
    '',
    'Notes:',
    '  • All execution is forwarded via the daemon webhook (default 127.0.0.1:3001).',
    '  • Without --task-id, exit/termination is still reported but no task lifecycle is touched.',
    '  • --task-id must be 4-char hex; invalid IDs cause a non-zero exit before dispatch.',
  ].join('\n');
}

/**
 * Returns true if the user is asking for help at the top level.
 * `--help` / `-h` that appear AFTER the `--` separator belong to the user
 * command and must not be treated as cortex-run help requests.
 */
function isHelpRequest(rawArgs: string[]): boolean {
  if (rawArgs.length === 0) return true;
  const sepIdx = rawArgs.indexOf('--');
  const helpIdx = rawArgs.indexOf('--help');
  const shortIdx = rawArgs.indexOf('-h');
  const firstHelp = [helpIdx, shortIdx].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  if (firstHelp == null) return false;
  return sepIdx === -1 || firstHelp < sepIdx;
}

function parseCliArgs(): CortexRunArgs {
  const rawArgs = process.argv.slice(2);

  // Detect --cancel mode: only if no -- separator present, or --cancel is before --
  const sepIdx = rawArgs.indexOf('--');
  const cancelIdx = rawArgs.indexOf('--cancel');
  const isCancelMode = cancelIdx !== -1 && (sepIdx === -1 || cancelIdx < sepIdx);
  if (isCancelMode) {
    const cancelArgs = rawArgs.slice(0);
    const { values } = parseArgs({
      args: cancelArgs,
      options: {
        cancel: { type: 'string' },
        device: { type: 'string' },
        signal: { type: 'string', default: 'SIGTERM' },
      },
      strict: true,
      allowPositionals: true,
    });

    if (!values.cancel) {
      console.error('Error: --cancel requires a run name.');
      process.exit(2);
    }

    return {
      cancel: values.cancel,
      device: values.device || getLocalMachine(),
      signal: values.signal || 'SIGTERM',
      name: undefined,
      command: undefined,
      project: null,
      taskId: null,
      envPassthrough: [],
      logTailBytes: 5000,
      stall: '10m',
      gpu: 'auto',
      force: false,
    };
  }

  // Launch mode: -- separator required
  if (sepIdx === -1) {
    console.error('Error: No command specified. Use -- to separate cortex-run args from command.');
    process.exit(2);
  }

  const cortexArgs = rawArgs.slice(0, sepIdx);
  const command = rawArgs.slice(sepIdx + 1);

  if (command.length === 0) {
    console.error('Error: No command specified after --.');
    process.exit(2);
  }

  // --cancel inside launch mode (after --) is not cancel mode; but if --cancel
  // appears in cortexArgs, parseArgs will reject it since it's not in the
  // launch option list. That's a usage error.
  const { values } = parseArgs({
    args: cortexArgs,
    options: {
      name:            { type: 'string' },
      device:          { type: 'string' },
      stall:           { type: 'string', default: '10m' },
      gpu:             { type: 'string', default: 'auto' },
      force:           { type: 'boolean', default: false },
      'task-project':  { type: 'string' },
      'task-id':       { type: 'string' },
      'env-passthrough': { type: 'string' },
      'log-tail-bytes': { type: 'string' },
    },
    strict: true,
  });

  if (!values.name) {
    console.error('Error: --name is required.');
    process.exit(2);
  }

  const rawTaskId = values['task-id'] || null;
  if (rawTaskId && !/^[0-9a-fA-F]{4}$/.test(rawTaskId)) {
    console.error(
      `[cortex-run] FATAL: --task-id='${rawTaskId}' is not a valid 4-char hex hash. ` +
      `Refusing to start — fix the launch command.`
    );
    process.exit(1);
  }

  // Parse env-passthrough (comma-separated key list)
  const envPassthrough: string[] = [];
  if (values['env-passthrough']) {
    for (const key of values['env-passthrough'].split(',').map(s => s.trim()).filter(Boolean)) {
      envPassthrough.push(key);
    }
  }

  // Parse log-tail-bytes
  let logTailBytes = 5000;
  if (values['log-tail-bytes']) {
    logTailBytes = parseInt(values['log-tail-bytes'], 10);
    if (isNaN(logTailBytes) || logTailBytes < 0) {
      console.error(`Error: invalid --log-tail-bytes '${values['log-tail-bytes']}'.`);
      process.exit(2);
    }
  }

  return {
    name: values.name,
    device: values.device || getLocalMachine(),
    command,
    project: values['task-project'] || null,
    taskId: rawTaskId,
    envPassthrough,
    logTailBytes,
    cancel: null,
    signal: 'SIGTERM',
    stall: values.stall,
    gpu: values.gpu,
    force: values.force,
  };
}

// --- Launch (DR-0011 §4.8) ---

async function cmdLaunch(args: CortexRunArgs): Promise<void> {
  const device = args.device;
  const hasTaskContext = !!args.project && !!args.taskId
    && process.env.CORTEX_TASK_PROJECT === args.project
    && process.env.CORTEX_TASK_ID === args.taskId;
  const dispatchGeneration = resolveTaskGeneration(args.project, args.taskId);
  const ownership = hasTaskContext ? { generation: dispatchGeneration } : undefined;

  if (!(await httpIsDeviceOnline(device))) {
    console.error(`[cortex-run] Error: device "${device}" is not online (cortex-client not connected)`);
    process.exit(1);
  }

  // --env-passthrough: extract values from server process.env
  const passthroughEnv: Record<string, string> = {};
  for (const key of args.envPassthrough) {
    if (process.env[key] !== undefined) {
      passthroughEnv[key] = process.env[key]!;
    }
  }

  // Task linkage: mark pending (belt-and-suspenders, non-blocking)
  if (args.project && args.taskId) {
    try {
      const result = pendingTask(null, args.project, args.taskId, ownership);
      if ('stale' in result && result.stale) {
        console.error(`[cortex-run] Error: ${result.message}`);
        process.exit(1);
      } else if (!result.success) {
        console.error(`[cortex-run] Warning: pendingTask failed: ${result.message}`);
      } else {
        console.log(`[cortex-run] Task ${args.taskId} marked pending`);
      }
    } catch (e: any) {
      console.error(`[cortex-run] Warning: pendingTask error: ${e.message}`);
    }
  }

  // Single pathway: all launch via sendCommand
  let result: any;
  try {
    result = await httpSendCommand(device, {
      action: 'cortex-run.launch',
      params: {
        name: args.name,
        command: args.command,
        stall: args.stall,
        gpu: args.gpu,
        force: args.force,
        cwd: process.cwd(),
        env: passthroughEnv,
        logTailBytes: args.logTailBytes,
        taskProject: args.project,
        taskId: args.taskId,
        dispatchGeneration,
      },
      timeout: 30_000,
    });
  } catch (e: any) {
    console.error(`[cortex-run] Error: launch failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`[cortex-run] launched on ${device}`);
  console.log(`[cortex-run]   pid=${result.pid}`);
  console.log(`[cortex-run]   callbackId=${result.callbackId}`);
  console.log(`[cortex-run]   resultDir=${result.resultDir}`);
  console.log(`[cortex-run] task lifecycle will be reported back via task-callback`);
  process.exit(0);
}

// --- Cancel (DR-0011 §4.9) ---

async function cmdCancel(args: CortexRunArgs): Promise<void> {
  const device = args.device;

  if (!(await httpIsDeviceOnline(device))) {
    console.error(`[cortex-run] Error: device "${device}" is not online (cortex-client not connected)`);
    process.exit(1);
  }

  let result: any;
  try {
    result = await httpSendCommand(device, {
      action: 'cortex-run.cancel',
      params: {
        name: args.cancel,
        signal: args.signal,
      },
      timeout: 30_000,
    });
  } catch (e: any) {
    console.error(`[cortex-run] Error: cancel failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`[cortex-run] cancel signal sent to ${device}: ${args.cancel}`);
  console.log(`[cortex-run]   killed=${result.killed} (pid=${result.pid})`);
  process.exit(0);
}

// --- Main entry ---

export { parseCliArgs, getCortexRunHelp, isHelpRequest, resolveTaskGeneration };

// Use the shared isMainModule helper so symlink invocations (e.g. via the
// global `cortex-run` bin) follow through to realpath comparison. The
// hand-rolled `path.resolve` variant previously here did not follow symlinks
// and silently skipped main() when invoked via the npm global bin link.
if (isMainModule(import.meta.url)) {
  if (isHelpRequest(process.argv.slice(2))) {
    process.stdout.write(`${getCortexRunHelp()}\n`);
    process.exit(0);
  }
  const args = parseCliArgs();
  if (args.cancel) {
    await cmdCancel(args);
  } else {
    await cmdLaunch(args);
  }
}
