// input:  the adapter's own contract modules
// output: the shared agent-adapter contract surface (types, capabilities, events, hooks)
// pos:    Contract entry point for the Agent adapter system; assembly lives in domain/runs/adapters.ts
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export * from './types.js';
export * from './capabilities.js';
export * from './normalize/event-types.js';
export * from './normalize/hooks.js';
export * from '@core/tool-names.js';
