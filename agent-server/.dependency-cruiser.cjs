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

// Standalone checks cover only production entry and factory seams. Direct runtime composition is
// forbidden; reusable transitive dependencies and type-only contracts remain outside this static
// boundary and are verified by construction/runtime evidence instead.
const STANDALONE_COMPOSITION_SURFACES = {
  path: '^src/domain/(agent-run/(runner|standalone-composition|standalone-stores|benchmark-output-adapter)|benchmark/trial-adapter-factory)\\.ts$',
};
const DIRECT_RUNTIME_ONLY = { dependencyTypesNot: ['type-only'] };

const STANDALONE_COMPOSITION_RULES = [
  {
    name: 'standalone-root-no-daemon',
    severity: 'error',
    comment: 'standalone entry and factories may not compose daemon state, shared scheduling, or entry points',
    from: STANDALONE_COMPOSITION_SURFACES,
    to: {
      path: '^src/(entry/(app|daemon)|domain/(scheduling/(job-registry|scheduler)|mcp/tools/(thread-ops|manager-qa)))\\.ts$',
      ...DIRECT_RUNTIME_ONLY,
    },
  },
  {
    name: 'standalone-root-no-platform',
    severity: 'error',
    comment: 'standalone entry and factories may not compose platform delivery adapters',
    from: STANDALONE_COMPOSITION_SURFACES,
    to: { path: '^src/platform/', ...DIRECT_RUNTIME_ONLY },
  },
  {
    name: 'standalone-root-no-remote',
    severity: 'error',
    comment: 'standalone entry and factories may not compose remote device clients',
    from: STANDALONE_COMPOSITION_SURFACES,
    to: { path: '^src/domain/remote/', ...DIRECT_RUNTIME_ONLY },
  },
  {
    name: 'standalone-root-no-update',
    severity: 'error',
    comment: 'standalone entry and factories may not compose update or release machinery',
    from: STANDALONE_COMPOSITION_SURFACES,
    to: {
      path: '^src/domain/system/(server-update-check|update-prompt|update-state|github-release|install-cli)\\.ts$',
      ...DIRECT_RUNTIME_ONLY,
    },
  },
  {
    name: 'standalone-root-no-host-stores',
    severity: 'error',
    comment: 'standalone entry and factories may not compose ambient or host runtime stores',
    from: STANDALONE_COMPOSITION_SURFACES,
    to: {
      path: '^src/(store/(task-repo|thread-repo|session-registry-repo|execution-repo|profile-repo|schedule-repo)\\.ts|domain/(projects|memory)/)',
      ...DIRECT_RUNTIME_ONLY,
    },
  },
  {
    name: 'standalone-root-no-outbound',
    severity: 'error',
    comment: 'standalone entry and factories may not compose the daemon outbound queue',
    from: STANDALONE_COMPOSITION_SURFACES,
    to: {
      path: '^src/(store/outbound-queue|domain/system/system-notice)\\.ts$',
      ...DIRECT_RUNTIME_ONLY,
    },
  },
  {
    name: 'standalone-root-no-ambient-roots',
    severity: 'error',
    comment: 'standalone entry and factories may not resolve state from ambient Cortex roots',
    from: STANDALONE_COMPOSITION_SURFACES,
    to: { path: '^src/core/paths\\.ts$', ...DIRECT_RUNTIME_ONLY },
  },
];

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
    ...STANDALONE_COMPOSITION_RULES,
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
