// input:  Backend type from types.ts
// output: Capability enum, Claude/PI capability matrix, long-MCP-call version governance
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
  // per-call budget. See LONG_MCP_CALL_VERSION_GOVERNANCE for the read evidence.
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

/** Who governs how long one MCP tool call may run, per backend. Which process owns the MCP client
 *  decides this, so it is declared per backend and never inferred: an empty allowlist would say
 *  "nothing verified yet" and "version is not the governing fact" in the same bytes. */
export type LongMcpCallVersionGovernance =
  /** The backend's own CLI owns the MCP client and reads the per-call budget itself, so the exact
   *  version is evidence. Closed allowlist, never an ordering: an unknown, unorderable or malformed
   *  version is simply not a member. */
  | { readonly governed_by: 'cli-version'; readonly verified_versions: readonly string[] }
  /** Cortex's own bridge is the MCP client, over an SDK pinned by our lockfile, so the backend
   *  binary's version governs nothing here and the cited proof governs instead. */
  | { readonly governed_by: 'cortex-bridge'; readonly proof: string };

// Every backend declares its governance. Nothing here is a default: the compiler refuses a backend
// that is absent from this table, so a backend added later lands on the refusing branch until
// someone writes down which of the two facts is true of it and why.
//
// claude 2.1.220, admitted by reading the installed bundle: MCP_TOOL_TIMEOUT is read from
// process.env and becomes the per-call hard timeout when > 0 (unset default 1e8 ms), clamped to
// 2147483647 ms, so no ceiling lands below a trial deadline; the stdio idle timeout defaults to
// 1800000 ms and is itself clamped by that hard timeout.
//
// pi is exempt on measured evidence rather than on absence of evidence: with the bridge supplying
// explicit call options, one real call was held 63324 ms while a no-options control client on a
// second server was cut at the SDK's 60 s default, and a 90 s hold was still bounded by the trial
// deadline. Upgrading the `pi` binary cannot change that; changing the bridge or its pinned SDK can,
// which is why the proof names a suite rather than a release string.
export const LONG_MCP_CALL_VERSION_GOVERNANCE = {
  claude: { governed_by: 'cli-version', verified_versions: ['2.1.220 (Claude Code)'] },
  pi: {
    governed_by: 'cortex-bridge',
    proof: 'tests/domain/agent-run/long-mcp-call-e2e.test.ts',
  },
} as const satisfies Record<Backend, LongMcpCallVersionGovernance>;
