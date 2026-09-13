/** @type {import('dependency-cruiser').IConfiguration} */
//
// Layer rules (plan/agent-server-decouple.md §2.2):
//   core    → ()                         L0
//   store   → core                       L1
//   events  → core                       L2
//   platform→ core, events               L3
//   domain  → core, store, events, platform   L3 (platform allowed: domain services use adapter
//                                              to send messages, render tool traces, post status,
//                                              monitor disk/GPU; this was implicit in the original
//                                              design and made explicit here)
//   orch    → core, store, events, domain, platform   L4
//   entry   → *                          L5
//
//   agent-adapter → core, store, events   (a driver: it knows how to talk to a CLI, and nothing
//                                          about what a throttle, a usage row, a subagent run or
//                                          an MCP bundle *means*. Plan D10.)
//
// Severity is `error` so CI breaks on new violations. Type-only imports are excluded
// (dependencyTypesNot: ['type-only']) — type leaks across layers are tolerated; runtime
// coupling is what we want to catch.
//
// Known exceptions are removed — after S4 refactor, store no longer imports from domain.
// See plan/task-repo-decouple.md for the refactor history.
//
const COMMON_OPTS = { dependencyTypesNot: ['type-only'] };

module.exports = {
  forbidden: [
    {
      name: 'core-not-to-other-layers',
      severity: 'error',
      comment: 'core must have zero runtime dependencies on other layers',
      from: { path: '^src/core/' },
      to: { path: '^src/(store|events|domain|orchestration|platform|entry)/', ...COMMON_OPTS },
    },
    {
      name: 'store-known-exceptions-only',
      severity: 'error',
      comment: 'store may only depend on core; any import to other layers is a violation (profile-repo → domain handled by type-only exemption)',
      from: { path: '^src/store/' },
      to: { path: '^src/(events|domain|orchestration|platform|entry)/', ...COMMON_OPTS },
    },
    {
      name: 'events-not-to-other-layers',
      severity: 'error',
      comment: 'events may only depend on core',
      from: { path: '^src/events/' },
      to: { path: '^src/(store|domain|orchestration|platform|entry)/', ...COMMON_OPTS },
    },
    {
      name: 'platform-only-core-events',
      severity: 'error',
      comment: 'platform may only depend on core and events',
      from: { path: '^src/platform/' },
      to: { path: '^src/(store|domain|orchestration|entry)/', ...COMMON_OPTS },
    },
    {
      name: 'domain-not-to-orch-or-entry',
      severity: 'error',
      comment: 'domain may depend on core, store, events, platform — but never on orchestration or entry',
      from: { path: '^src/domain/' },
      to: { path: '^src/(orchestration|entry)/', ...COMMON_OPTS },
    },
    {
      name: 'adapter-no-upward-deps',
      severity: 'error',
      comment:
        'agent-adapter is a driver, not a layer above domain: it may read downward (core, store, '
        + 'events) but must never import domain, orchestration, entry or platform. Anything it '
        + 'needs from those is either shared vocabulary that belongs in core, or a collaborator '
        + 'injected at the one assembly point, domain/runs/adapters.ts (plan D10). NOTE: the plan '
        + 'named this rule "core|events only"; store is allowed deliberately — it sits BELOW the '
        + 'adapter (L1) and the hook registry two adapter files read is passive config data, so '
        + 'forbidding it would buy a pass-through injection and no isolation.',
      from: { path: '^src/agent-adapter/' },
      to: { path: '^src/(domain|orchestration|entry|platform)/', ...COMMON_OPTS },
    },
    {
      name: 'orch-not-to-entry',
      severity: 'error',
      comment: 'orchestration may not depend on entry',
      from: { path: '^src/orchestration/' },
      to: { path: '^src/entry/', ...COMMON_OPTS },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
