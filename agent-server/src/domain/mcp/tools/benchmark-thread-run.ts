// input:  immutable benchmark policy, MCP request signal, local orchestrator
// output: one bounded blocking thread_run tool registration
// pos:    Benchmark-only thread admission and result boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  runBenchmarkThread, type BenchmarkThreadResult,
} from '../../agent-run/benchmark-local-thread-orchestrator.js';

export const BENCHMARK_THREAD_POLICY_ENV = 'CORTEX_BENCHMARK_THREAD_POLICY_PATH';
export const MAX_BENCHMARK_HANDOFF_LENGTH = 2_000;
const MAX_BENCHMARK_SUMMARY_CODE_POINTS = 2_000;

const policySchema = z.object({
  schema_version: z.literal('cortex-benchmark-thread-policy/1'),
  canonical_instruction: z.string().min(1),
  workspace_cwd: z.string().min(1).refine(path.isAbsolute, 'workspace_cwd must be absolute'),
  template: z.literal('benchmark-coder-review'),
  profile_name: z.string().min(1),
  root_run_id: z.string().min(1),
  trajectory_root: z.string().min(1).refine(path.isAbsolute, 'trajectory_root must be absolute'),
  limits: z.object({
    max_calls: z.literal(1),
    max_steps: z.number().int().positive(),
    max_cost_usd: z.number().nonnegative().finite(),
    deadline_epoch_ms: z.number().int().positive(),
  }).strict(),
}).strict();

const inputSchema = z.object({
  handoff: z.string().max(MAX_BENCHMARK_HANDOFF_LENGTH).optional(),
}).strict();

const summarySchema = z.string()
  .max(MAX_BENCHMARK_SUMMARY_CODE_POINTS * 2)
  .refine(
    value => Array.from(value).length <= MAX_BENCHMARK_SUMMARY_CODE_POINTS,
    `Summary must not exceed ${MAX_BENCHMARK_SUMMARY_CODE_POINTS} Unicode code points`,
  );

const outputSchema = z.object({
  thread_id: z.string().min(1),
  status: z.literal('completed'),
  artifact_path: z.string().nullable(),
  trajectory_paths: z.object({ journal: z.string(), manifest: z.string() }).strict(),
  steps: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
  summary: summarySchema,
}).strict();

type BenchmarkThreadPolicy = Readonly<z.infer<typeof policySchema>>;
type ThreadRunInput = z.infer<typeof inputSchema>;
type ThreadRunOutput = z.infer<typeof outputSchema>;

function readPolicyFile(file: string): unknown {
  if (!path.isAbsolute(file)) throw new Error(`${BENCHMARK_THREAD_POLICY_ENV} must be absolute`);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Benchmark thread policy must be a regular file');
  if ((stat.mode & 0o222) !== 0) throw new Error('Benchmark thread policy must be read-only');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadBenchmarkThreadPolicy(
  env: NodeJS.ProcessEnv = process.env,
): BenchmarkThreadPolicy {
  const file = env[BENCHMARK_THREAD_POLICY_ENV];
  if (!file) throw new Error(`${BENCHMARK_THREAD_POLICY_ENV} is required`);
  const policy = policySchema.parse(readPolicyFile(file));
  Object.freeze(policy.limits);
  return Object.freeze(policy);
}

function linkedSignal(request: AbortSignal, shutdown: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const link = (signal: AbortSignal) => {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  };
  link(request);
  link(shutdown);
  return controller.signal;
}

function orchestratorRequest(
  policy: BenchmarkThreadPolicy,
  input: ThreadRunInput,
  signal: AbortSignal,
) {
  return {
    workspaceCwd: policy.workspace_cwd,
    template: policy.template,
    instruction: policy.canonical_instruction,
    handoff: input.handoff,
    profileName: policy.profile_name,
    rootRunId: policy.root_run_id,
    trajectoryRoot: policy.trajectory_root,
    limits: {
      maxSteps: policy.limits.max_steps,
      maxCostUsd: policy.limits.max_cost_usd,
      deadlineEpochMs: policy.limits.deadline_epoch_ms,
    },
    signal,
  };
}

function successPayload(result: BenchmarkThreadResult): ThreadRunOutput {
  return {
    thread_id: result.threadId,
    status: 'completed',
    artifact_path: result.artifactPath,
    trajectory_paths: { journal: result.journalPath, manifest: result.manifestPath },
    steps: result.steps,
    cost_usd: result.costUsd,
    duration_ms: result.durationMs,
    summary: result.summary,
  };
}

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function failedRunResult(result: BenchmarkThreadResult) {
  return textResult({
    code: `benchmark_thread_${result.state}`,
    status: result.state,
    terminal_reason: result.terminalReason,
  }, true);
}

function callLimitResult() {
  return textResult({
    code: 'benchmark_thread_call_limit_exceeded',
    message: 'thread_run has already been admitted for this trial',
  }, true);
}

export function registerBenchmarkThreadRunTool(
  server: McpServer,
  policy: BenchmarkThreadPolicy,
  shutdownSignal: AbortSignal,
): void {
  let admitted = false;
  server.registerTool('thread_run', {
    description: 'Run the trial policy\'s fixed benchmark coder-review thread once and block until its durable terminal state is committed. The optional handoff adds supplementary context; execution policy cannot be supplied through tool input.',
    inputSchema,
    outputSchema,
  }, async (input, extra) => {
    if (admitted) return callLimitResult();
    admitted = true;
    try {
      const signal = linkedSignal(extra.signal, shutdownSignal);
      const result = await runBenchmarkThread(orchestratorRequest(policy, input, signal));
      if (result.state !== 'completed' || !result.manifestCommitted) {
        return failedRunResult(result);
      }
      const payload = successPayload(result);
      return { ...textResult(payload), structuredContent: payload };
    } catch (error) {
      return textResult({
        code: 'benchmark_thread_run_failed', message: (error as Error).message,
      }, true);
    }
  });
}
