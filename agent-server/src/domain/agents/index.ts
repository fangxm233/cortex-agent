// input:  the agents domain modules (config, profile-switch, facade)
// output: the public agents-domain API, minus the run entry points
// pos:    domain/agents barrel — [S11] split from mode-manager.ts
// Usage: import { getActiveBackend, getActiveProfile, ... } from './domain/agents/index.js';
//
// `runAgent` / `runAgentOnce` are deliberately NOT re-exported: starting a run is now the run
// layer's job. Import `startRun` from `@domain/runs/service.js` instead. The facade still defines
// and exports them for `domain/runs/run.ts` and the facade's own tests.

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
  _test,
  claudeTest,
  getCurrentPlanFilePath,
} from './facade.js';
export type {
  AgentConfig, RunAgentOptions, RunObserver, CompactAgentRequest, CompactAgentDeps,
} from './facade.js';
