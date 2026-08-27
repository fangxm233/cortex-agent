// input:  Session running, background-hold, and run-history facts
// output: Locale-free foreground/background/idle/fresh status facts
// pos:    Shared desktop/mobile session run-status derivation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export type SessionRunPhase = 'foreground' | 'background' | 'idle' | 'fresh';

export interface SessionRunStatusInput {
  running: boolean;
  backgroundRunning: boolean;
  hasRun: boolean;
}

export interface SessionRunStatus {
  phase: SessionRunPhase;
  active: boolean;
  showMetrics: boolean;
  showCost: boolean;
}

/**
 * Classifies transport/runtime facts without choosing copy or presentation. A background hold is
 * still active, but its foreground turn is complete; only a completed idle run has finalized cost.
 */
export function deriveSessionRunStatus(input: SessionRunStatusInput): SessionRunStatus {
  if (input.running && input.backgroundRunning) {
    return { phase: 'background', active: true, showMetrics: true, showCost: false };
  }
  if (input.running) {
    return { phase: 'foreground', active: true, showMetrics: true, showCost: false };
  }
  if (input.hasRun) {
    return { phase: 'idle', active: false, showMetrics: true, showCost: true };
  }
  return { phase: 'fresh', active: false, showMetrics: false, showCost: false };
}
