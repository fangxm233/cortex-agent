// Barrel re-export for domain/threads/ — single import surface for all callers.
// Physical split: utils / artifact-io / template-loader / prompt-builder / state-machine / tree /
// contract. Prefer importing from here rather than from a sub-file.
//
// runner.ts and hook-runner.ts are deliberately NOT re-exported: both import this barrel, so
// adding them here creates a cycle. auto-thread.ts (a dependency-free leaf) is also kept out.
// Import those three directly.

export * from './utils.js';
export * from './artifact-io.js';
export * from './template-loader.js';
export * from './prompt-builder.js';
export * from './state-machine.js';
export * from './tree.js';
export * from './contract.js';
