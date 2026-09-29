import type { Backend } from './types.js';

export enum Capability {
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

// Claude: account quota is observed by the local HTTP gateway.
const CLAUDE_CAPS: Capability[] = [
  // Print mode accepts a user message written to stdin while a turn is in flight.
  Capability.MidTurnInject,
  // A child is one frozen one-shot CLI run, observed through the normalized event stream.
  Capability.Subagents,
  // The CLI opens a turn of its own when a background task finishes (or when a message injected
  // after the result is consumed), so a run has a background phase to hold a session for.
  Capability.BackgroundContinuation,
];

const PI_CAPS: Capability[] = [
  // RPC prompt streamingBehavior=steer queues a message at the next agent-loop boundary.
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
