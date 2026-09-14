// input:  the agents domain modules (config, profile-switch, profile-manager)
// output: the public agents-domain API: profiles, modes, credentials and channel selection
// pos:    domain/agents barrel — [S11] split from mode-manager.ts
// Usage: import { getActiveBackend, getActiveProfile, ... } from './domain/agents/index.js';
//
// Profiles / roles / credentials only. Starting a run, compacting a session and the engine spec
// all belong to the run layer: import `startRun` from `@domain/runs/service.js`,
// `compactAgentContext` from `@domain/runs/compact.js`, `buildEngineSpec` from
// `@domain/runs/engine-spec.js`.

export * from './config.js';
export * from './profile-switch.js';
export * from './model-selection.js';
export { resolveRateLimitProvider } from './provider-run-lifecycle.js';
export {
  buildPiGatewaySubPath,
  CHANNEL_SCOPED_PLUGINS, COMMISSION_SCOPED_PLUGINS,
  filterChannelScopedPlugins, filterScopedPlugins,
} from '../runs/engine-spec.js';
