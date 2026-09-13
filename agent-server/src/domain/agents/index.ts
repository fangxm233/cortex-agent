// input:  the agents domain modules (config, profile-switch, facade)
// output: the public agents-domain API, minus the run entry points and facade/adapter internals
// pos:    domain/agents barrel — [S11] split from mode-manager.ts
// Usage: import { getActiveBackend, getActiveProfile, ... } from './domain/agents/index.js';
//
// Profiles / roles / credentials only. `runAgent` / `runAgentOnce` are deliberately NOT
// re-exported: starting a run is now the run layer's job. Import `startRun` from
// `@domain/runs/service.js` instead. Adapter internals and the facade's test hook are not part of
// this barrel either — import `domain/agents/facade.js` directly for facade test hooks.

export * from './config.js';
export * from './profile-switch.js';
export {
  resolveRateLimitProvider,
  buildPiGatewaySubPath,
  CHANNEL_SCOPED_PLUGINS, COMMISSION_SCOPED_PLUGINS,
  filterChannelScopedPlugins, filterScopedPlugins,
  runWithAdapter,
  isSessionCompactionSupported,
  compactAgentContext,
  allConfigsRateLimited,
} from './facade.js';
export type {
  AgentConfig, RunAgentOptions, RunObserver, CompactAgentRequest, CompactAgentDeps,
} from './facade.js';
