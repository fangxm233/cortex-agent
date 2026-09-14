// input:  Backend type
// output: Capability enum and backend capability matrix
// pos:    Declares backend feature capabilities
// >>> If I am updated, update this header and folder CORTEX.md <<<

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
  /** Backend can return scoped provider usage from a pull source or push cache. */
  Usage = 'usage',
  /** Backend opens a continuation turn of its own after a foreground result — a background task
   *  finishing, or an injected message consumed once the turn was over. What an interactive
   *  surface's `hold` needs: without it there is nothing to hold a session open for. */
  BackgroundContinuation = 'background-continuation',
  /** Backend can be the *child* of a delegated `agent` run: Cortex knows how to start a one-shot
   *  run on it, stream its events back under the parent's attribution, and collect a result.
   *  Gated on rather than branching on the backend name, so adding a third backend is a matter of
   *  declaring this and supplying a branch in `domain/agents/subagent/runner.ts`. */
  Subagents = 'subagents',
}

// Claude: native turn support; account quota is observed by the local HTTP gateway.
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
  // A child is one frozen one-shot CLI run, observed through the normalized event stream.
  Capability.Subagents,
  // The CLI opens a turn of its own when a background task finishes (or when a message injected
  // after the result is consumed), so a run has a background phase to hold a session for.
  Capability.BackgroundContinuation,
];

// PI uses --skill for plugins, --system-prompt for overrides, and adapter tool gates.
// mcp-bridge.ts supplies built-in/plugin MCP plus shared plan and ask interaction tools.
// SessionResume uses --session <path>.
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
  // Codex quota is push-only; PI reads the daemon-owned cache and never initiates provider traffic.
  Capability.Usage,
  // A child is a nested in-process SDK session driven by `pi/child-runner.ts`.
  Capability.Subagents,
];

export const CAPABILITIES_BY_BACKEND: Record<Backend, Set<Capability>> = {
  claude: new Set(CLAUDE_CAPS),
  pi: new Set(PI_CAPS),
};
