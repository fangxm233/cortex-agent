/**
 * Counts Claude Code installs this server has completed. A pooled process keeps running the binary
 * it was spawned from, so the count is part of the reuse identity: after an update, each idle
 * session is replaced with a new process on its next turn, while running turns are left alone.
 */
let generation = 0;

export function claudeCliGeneration(): number {
  return generation;
}

export function bumpClaudeCliGeneration(): void {
  generation += 1;
}
