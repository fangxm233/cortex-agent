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

// ---------------------------------------------------------------------------
// Benchmark isolation rules X1-X13 (design §7.3, executable form frozen by §18(b)).
//
// Subject (G5-R1): `from` stays `^src/domain/benchmark/` for all thirteen. §7.3's reachable
// closure is expressed on the `to` side, so every violation names the benchmark module that owns
// the reach rather than an intermediate nobody owns. No module outside `src/domain/benchmark/` is
// ever the subject of a rule here.
//
// Type-only deviation (§7.3 deviation 1, design:2305-2310, measured as G5-R2): the benchmark
// rules omit `dependencyTypesNot: ['type-only']` that the six shipped layer rules set at
// COMMON_OPTS. `local-runtime-deps.ts:10,37` was exactly a type-only reach into daemon `jobCtx`,
// and a type-only reference is one edit away from a runtime one. For the twelve reachability
// rules the omission is structural, not stylistic: dependency-cruiser 17.3.10 rejects any key
// besides `path`/`pathNot`/`reachable` inside a `to` clause carrying `reachable`, so re-adding
// `dependencyTypesNot` is a config-validation failure that stops the cruise, not a weakening.
// X10 is the one rule where the key would validate; its omission is deliberate and guarded by the
// inline comment on that rule. The six shipped rules' own `dependencyTypesNot` is untouched.
//
// Staging (manager ruling G5-D7, shape frozen by §18(b) G5-R6/G5-R7/G5-R8): every rule is written
// at full strength — no `pathNot`, no path exemption, no softened target. The only field that
// differs between the two arrays is `severity`. LIVE rules are wired to the repo-wide lint gate.
// STAGED rules are evaluated by every cruise but report nothing, because their violating routes
// run through modules outside Gate 5's scope that Gate 5 has no authority to change; each STAGED
// rule records its measured count, the non-Gate-5 module on its route, and that module's owner.
// The counts are pinned by tests/domain/benchmark/isolation-rules.test.ts, which promotes every
// staged rule to `error` and asserts the count exactly — an increase is a new coupling and fails,
// a decrease requires the pin lowered in the same commit. `severity: 'ignore'` is used rather
// than a sibling top-level key because an unknown top-level key fails config validation outright
// and a `.cjs` module has exactly one export object (G5-R7).
// ---------------------------------------------------------------------------
const BENCHMARK_FROM = { path: '^src/domain/benchmark/' };

const BENCHMARK_ISOLATION_LIVE = [
  {
    name: 'benchmark-isolation-x3-outbound-queue',
    severity: 'error',
    comment: '§7.3 X3: the composite path may not reach the daemon outbound queue (durablePost enqueues to a shared store)',
    from: BENCHMARK_FROM,
    to: { path: '^src/store/outbound-queue\\.ts$', reachable: true },
  },
  {
    name: 'benchmark-isolation-x4-host-stores',
    severity: 'error',
    comment: '§7.3 X4: the composite path may not reach the four host store module singletons (taskStore, threadStore, sessionStore, executionRepo) — these are the objects the §7.2 P7 ports displace, and reaching them is how a composite path touches the host store with a clean import graph (§7.1 I3)',
    from: BENCHMARK_FROM,
    to: { path: '^src/store/(task-repo|thread-repo|session-registry-repo|execution-repo)\\.ts$', reachable: true },
  },
  {
    name: 'benchmark-isolation-x6-remote-devices',
    severity: 'error',
    comment: '§7.3 X6: the composite path may not reach remote device connections (client-manager, cortex-client)',
    from: BENCHMARK_FROM,
    to: { path: '^src/domain/remote/', reachable: true },
  },
  {
    name: 'benchmark-isolation-x7-gpu',
    severity: 'error',
    comment: '§7.3 X7: the composite path may not reach the GPU monitor (queryGpuSnapshot shells out to the host)',
    from: BENCHMARK_FROM,
    to: { path: '^src/domain/monitor/gpu-monitor\\.ts$', reachable: true },
  },
  {
    name: 'benchmark-isolation-x8-update',
    severity: 'error',
    comment: '§7.3 X8: the composite path may not reach the update path, which writes host state and installs; preventive and cheap (design:2293)',
    from: BENCHMARK_FROM,
    to: { path: '^src/domain/system/(server-update-check|update-prompt|update-state|github-release|install-cli)\\.ts$', reachable: true },
  },
  {
    name: 'benchmark-isolation-x9-git-shell-out',
    severity: 'error',
    comment: '§7.3 X9: the composite path may not reach TaskRepo.commitAndPush (which detaches `git push origin main`) or the task-completion git probes. Deliberately overlaps X4 on store/task-repo.ts — §7.3 lists it in both rows for different reasons and collapsing them would lose one',
    from: BENCHMARK_FROM,
    to: { path: '^src/(store/task-repo|domain/tasks/system/task-completion)\\.ts$', reachable: true },
  },
];

const BENCHMARK_ISOLATION_STAGED = [
  {
    name: 'benchmark-isolation-staged-x1-daemon-jobctx',
    severity: 'ignore',
    comment: '§7.3 X1: the composite path may not reach the shared mutable daemon `ctx` (job-registry.ts:24-39 — adapter, schedulerRef, bus). STAGED at 2 violations after the Gate-5 partition (3 before). Route module outside Gate 5: src/agent-adapter/claude/adapter.ts → domain/costs/rate-limit-throttle.ts:7 → domain/system/system-notice.ts:7 → job-registry.ts, reached from trial-adapter-factory.ts and (via agents/facade.ts) trial-thread-adapter.ts. Owner: Gate 2 owns agent-adapter/**; costs/ and system/ are owned by no gate of this plan',
    from: BENCHMARK_FROM,
    to: { path: '^src/domain/scheduling/job-registry\\.ts$', reachable: true },
  },
  {
    name: 'benchmark-isolation-staged-x2-platform-adapters',
    severity: 'ignore',
    comment: '§7.3 X2: the composite path may not reach platform adapters (a reachable PlatformAdapter is a live message-sending handle). STAGED at 168 violations, unchanged by the Gate-5 partition. Route module outside Gate 5: src/core/types/thread-types.ts:476 type-re-exports PlatformAdapter/MessageRef/Destination from @platform/index.js — an L0 module used repo-wide; second route domain/costs/rate-limit-throttle.ts:6. Owner: no gate of this plan (escalated as §18 G5-N1)',
    from: BENCHMARK_FROM,
    to: { path: '^src/platform/', reachable: true },
  },
  {
    name: 'benchmark-isolation-staged-x5-host-projects',
    severity: 'ignore',
    comment: '§7.3 X5: the composite path may not reach the host project registry (project-store.ts is a singleton over it). STAGED at 3 violations after the Gate-5 partition (6 before). Route module outside Gate 5: domain/agents/facade.ts → domain/costs/cost-tracker.ts → domain/projects/index.ts, reached from trial-thread-adapter.ts. Owner: no gate of this plan',
    from: BENCHMARK_FROM,
    to: { path: '^src/domain/projects/', reachable: true },
  },
  {
    name: 'benchmark-isolation-staged-x10-ambient-homes',
    severity: 'ignore',
    comment: '§7.3 X10: a benchmark module may not import the ambient home roots (DATA_DIR, CONFIG_DIR, STORE_DIR, CONTEXT_DIR, PROJECTS_DIR, WORKSPACE_DIR, PLUGINS_DIR, PROMPTS_DIR, HOOKS_DIR, LOGS_DIR and the CORTEX_HOME fallback) directly. DIRECT EDGE, not reachability (G5-D7): core/log.ts:8 imports core/paths.ts for LOGS_DIR, so 374/550 modules reach paths.ts transitively and the reachability form would express "this module logs", not "ambient home used as an implicit root". G5-R4 declares what this therefore does NOT catch: a benchmark module that reaches an ambient root through a helper is not caught here (proposal-seal.ts:8 → core/task-node.ts:13 → PROJECTS_DIR is one hop away today); that property is enforced at runtime by §7.2 P5\'s re-pointed root and §8.4 R5\'s resolve-then-contain check, not by this lint. STAGED, currently 0 in this direct-edge form; the reachability form is 13 and unachievable by Gate 5 (route would need domain/agent-run/run-config.ts owned by Gate 1, store/profile-repo.ts, and core/log.ts:8 owned by no gate). dependencyTypesNot is deliberately OMITTED here — this is the one rule of the thirteen where the key would validate, and §7.3 deviation 1 requires the omission (G5-R2)',
    from: BENCHMARK_FROM,
    to: { path: '^src/core/paths\\.ts$' },
  },
  {
    name: 'benchmark-isolation-staged-x11-ambient-hook-bus',
    severity: 'ignore',
    comment: '§7.3 X11: the composite path may not reach the ambient hook bus (emitCortexEvent publishes to a process-global bus — exactly the leak `disableHooks: true` exists to prevent, §6.5). STAGED at 2 violations after the Gate-5 partition (3 before). Route module outside Gate 5: the X1 chain continued, job-registry.ts → scheduling/scheduler.ts → core/hook-bus.ts. Owner: as X1 — Gate 2 owns agent-adapter/**; costs/, system/ and scheduling/ are owned by no gate of this plan',
    from: BENCHMARK_FROM,
    to: { path: '^src/core/hook-bus\\.ts$', reachable: true },
  },
  {
    name: 'benchmark-isolation-staged-x12-daemon-webhook',
    severity: 'ignore',
    comment: '§7.3 X12: the composite path may not use the daemon webhook transport. STAND-IN ONLY — the subject of X12 is a string literal (`http://127.0.0.1:${process.env.WEBHOOK_PORT}` and process.env.CORTEX_WEBHOOK_TOKEN) that dependency-cruiser cannot see at all, so the authoritative vehicle is the literal test in tests/domain/benchmark/isolation-literals.test.ts (G5-R5), not this rule. This module-path stand-in is STAGED at 0. Owner: Gate 5 owns the test',
    from: BENCHMARK_FROM,
    to: { path: '^src/domain/mcp/tools/(thread-ops|manager-qa)\\.ts$', reachable: true },
  },
  {
    name: 'benchmark-isolation-staged-x13-orchestration',
    severity: 'ignore',
    comment: '§7.3 X13: the composite path may not reach the orchestration layer — the extraction must move the reusable cores down into src/domain/ and leave the daemon wrappers behind (design:2298). STAGED at 2 violations after the Gate-5 partition (3 before). Route module outside Gate 5: src/agent-adapter/claude/event-parser.ts:9 → agent-adapter/normalize/prompt-builder.ts:1 (IMAGE_MIMES/VIDEO_MIMES from @orch/routing/file-handler.js) → orchestration/routing/file-handler.ts — an entirely runtime chain. Owner: Gate 2 owns agent-adapter/**. Note (G5-R10): the shipped domain-not-to-orch-or-entry rule does not catch this because src/agent-adapter/ has no layer rule at all; adding one is not Gate 5\'s (recorded as §18 G5-N2)',
    from: BENCHMARK_FROM,
    to: { path: '^src/orchestration/', reachable: true },
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
    ...BENCHMARK_ISOLATION_LIVE,
    ...BENCHMARK_ISOLATION_STAGED,
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
