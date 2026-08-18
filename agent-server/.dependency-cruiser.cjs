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
