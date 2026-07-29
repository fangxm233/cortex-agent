// input:  Backend type from types.ts
// output: Capability enum and Claude/PI capability matrix
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
];

export const CAPABILITIES_BY_BACKEND: Record<Backend, Set<Capability>> = {
  claude: new Set(CLAUDE_CAPS),
  pi: new Set(PI_CAPS),
};
