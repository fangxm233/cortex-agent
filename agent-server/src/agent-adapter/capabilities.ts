// input:  Backend type from types.ts
// output: Capability enum, Claude/PI capability matrix, verified long-MCP-call CLI versions
// pos:    Capability declaration matrix per backend
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { Backend } from './types.js';

export enum Capability {
  Hooks = 'hooks',
  Plugins = 'plugins',
  MCP = 'mcp',
  PlanMode = 'plan-mode',
  AskUserQuestion = 'ask-user-question',
  SystemPromptOverride = 'system-prompt-override',
  SessionResume = 'session-resume',
  ToolAllowlist = 'tool-allowlist',
  /** Backend republishes token-level assistant text as `assistant_delta` events while a block is
   *  still being generated. Rendered by the Web UI only. */
  StreamingDeltas = 'streaming-deltas',
  /** Backend accepts a user message into a turn already in flight (no new turn opened).
   *  Part of the shared capability vocabulary; declared by the backends that implement injection. */
  MidTurnInject = 'mid-turn-inject',
  /** Backend's configured MCP tool timeout and progress handling permit a single tool call to run
   *  beyond the native default while staying bounded by the trial deadline. Benchmark arms require
   *  it: a blocking benchmark tool call must not be cut short by an SDK or CLI default. */
  BenchmarkLongMcpCall = 'benchmark-long-mcp-call',
}

// Claude: full native support (claude-bridge.ts wires all ten shared capabilities).
// StreamingDeltas: `--include-partial-messages` token-level output.
// MidTurnInject: print mode accepts a user message on stdin while a turn is in flight.
const CLAUDE_CAPS: Capability[] = [
  Capability.Hooks,
  Capability.Plugins,
  Capability.MCP,
  Capability.PlanMode,
  Capability.AskUserQuestion,
  Capability.SystemPromptOverride,
  Capability.SessionResume,
  Capability.ToolAllowlist,
  // Print mode requests --include-partial-messages and republishes the resulting text deltas as
  // `assistant_delta` normalized events (Web UI preview only).
  Capability.StreamingDeltas,
  // Print mode accepts a user message written to stdin while a turn is in flight.
  Capability.MidTurnInject,
  // The CLI itself owns the MCP client, and it reads MCP_TOOL_TIMEOUT from the environment as the
  // per-call budget. See BENCHMARK_LONG_MCP_CALL_CLI_VERSIONS for the read evidence.
  Capability.BenchmarkLongMcpCall,
];

// PI: per DR-0008 §5.1 capability matrix — --skill for Plugins, --system-prompt for SystemPromptOverride, tool-allowlist via adapter;
// MCP enabled by mcp-bridge.ts extension (task 5754): auto-injected via --extension in PIAdapter.spawn();
// PlanMode/AskUserQuestion: implemented via tool-shims.ts pseudo-tools + extension_ui_response routing (Phase 2 §S3, 2026-04-27);
// SessionResume: S2 spike confirmed --session <path> resume works (DR-0008 §8 gate ticked, task 7ca9).
// MidTurnInject: RPC prompt streamingBehavior=steer queues a message at the next agent-loop boundary.
// Hooks via PI extension bridge per §3.5 — capability declared true because the extension is part of the default PI adapter package.
const PI_CAPS: Capability[] = [
  Capability.Hooks,
  Capability.Plugins,
  Capability.MCP,
  Capability.PlanMode,
  Capability.AskUserQuestion,
  Capability.SystemPromptOverride,
  Capability.ToolAllowlist,
  Capability.SessionResume,
  Capability.StreamingDeltas,
  Capability.MidTurnInject,
  // Admitted on measured evidence, not on the option shapes alone. PI's MCP calls are issued by the
  // Cortex bridge, which now supplies explicit timeout / maxTotalTimeout / resetTimeoutOnProgress
  // RequestOptions (`benchmarkCallOptions`, pi/mcp-duration.ts). An independently written suite held
  // one real call through that bridge for 63324 ms of wall clock while a no-options control client
  // on a second server was cut at the SDK's 60 s default; a second row ended a 90 s hold at ~9.6 s =
  // remaining budget + the 6000 ms cleanup grace despite progress notifications resetting the
  // per-call timeout, so the raised budget is still bounded by the trial deadline; a third proved
  // cancellation reaching the server rather than orphaning the request. The governing proof is
  // tests/domain/agent-run/long-mcp-call-e2e.test.ts — real wall clock, no fake timers.
  Capability.BenchmarkLongMcpCall,
];

export const CAPABILITIES_BY_BACKEND: Record<Backend, Set<Capability>> = {
  claude: new Set(CLAUDE_CAPS),
  pi: new Set(PI_CAPS),
};

// Closed allowlist of backend CLI versions proven to sustain a long MCP call, keyed by the exact
// `<cli> --version` output the trial compiles as its identity input. Membership is evidence-bearing
// and is never an ordering: an unknown, unorderable or malformed version is simply not a member.
//
// claude 2.1.220, admitted by reading the installed bundle: MCP_TOOL_TIMEOUT is read from
// process.env and becomes the per-call hard timeout when > 0 (unset default 1e8 ms), clamped to
// 2147483647 ms, so no ceiling lands below a trial deadline; the stdio idle timeout defaults to
// 1800000 ms and is itself clamped by that hard timeout.
//
// pi is empty, and not because PI is unverified: PI's MCP client is the Cortex bridge over a pinned
// SDK, so PI's call duration is governed by our code rather than by the `pi` binary's version.
export const BENCHMARK_LONG_MCP_CALL_CLI_VERSIONS: Record<Backend, readonly string[]> = {
  claude: ['2.1.220 (Claude Code)'],
  pi: [],
};
