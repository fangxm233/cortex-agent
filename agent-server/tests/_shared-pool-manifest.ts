// input:  none (static manifest)
// output: list of test files safe for the shared (isolate:false) fork pool
// pos:    read by vitest.config.ts when CORTEX_TEST_SHARD is set
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// A file may ONLY be listed here when ALL of the following hold — the shared
// pool reuses one module registry, one process.env, and one CORTEX_HOME across
// every file that lands in the same worker fork:
//   1. No writes under CORTEX_HOME / DATA_DIR / PROJECTS_DIR (own mkdtemp dirs
//      are fine). Reading seeded config is fine.
//   2. No imports of stateful module singletons (stores, registries, anything
//      tests elsewhere reset via _testReset / fresh-import helpers).
//   3. No fresh-import machinery (module-loader.ts, vi.resetModules, dynamic
//      import cache-busting) — pointless and misleading under isolate:false.
//   4. No subprocess spawn, no listeners/sockets, no fs.watch.
//   5. No process.env mutation (env persists across files in a worker) and no
//      process.on registrations.
//   6. No vi.useFakeTimers.
// When in doubt, leave the file in the isolated pool: correctness never
// depends on this list — without CORTEX_TEST_SHARD every file runs isolated.

export const SHARED_POOL_FILES: string[] = [
  'tests/agent-adapter/claude-bg-task-tracker.test.ts',
  'tests/agent-adapter/claude-compact-window.test.ts',
  'tests/agent-adapter/claude-cost-from-usage.test.ts',
  'tests/agent-adapter/normalize-assistant-delta.test.ts',
  'tests/agent-adapter-pi-agent-dir.test.ts',
  'tests/agent-adapter-pi-mcp-bridge.test.ts',
  'tests/agent-adapter.test.ts',
  'tests/app.test.ts',
  'tests/auto-compound.test.ts',
  'tests/cli-utils.test.ts',
  'tests/composite-adapter-noop-fallback.test.ts',
  'tests/core/auth.test.ts',
  'tests/core/config-generator.test.ts',
  'tests/core/debug-mode.test.ts',
  'tests/core/paths.test.ts',
  'tests/core/singleton-lock.test.ts',
  'tests/core/status-format.test.ts',
  'tests/cortex-client-config.test.ts',
  'tests/cortex-md-scanner.test.ts',
  'tests/domain/mcp/time-tool.test.ts',
  'tests/domain/mcp/tui-tools.test.ts',
  'tests/domain/system/doctor.test.ts',
  'tests/domain/tui-session/tui-session-service.test.ts',
  'tests/domain/ui-service/mutate-approvals.test.ts',
  'tests/domain/ui-service/mutate-executions.test.ts',
  'tests/domain/ui-service/mutate-issues.test.ts',
  'tests/domain/ui-service/mutate-projects.test.ts',
  'tests/domain/ui-service/mutate-sessions-create.test.ts',
  'tests/domain/ui-service/mutate-sessions-interactions.test.ts',
  'tests/domain/ui-service/mutate-sessions-markread.test.ts',
  'tests/domain/ui-service/mutate-threads.test.ts',
  'tests/domain/ui-service/query-approvals.test.ts',
  'tests/domain/ui-service/query-executions-get.test.ts',
  'tests/domain/ui-service/query-executions.test.ts',
  'tests/domain/ui-service/query-issues.test.ts',
  'tests/domain/ui-service/query-projects.test.ts',
  'tests/domain/ui-service/query-schedules.test.ts',
  'tests/domain/ui-service/query-tasks.test.ts',
  'tests/domain/ui-service/query-thread-detail.test.ts',
  'tests/domain/ui-service/query-threads.test.ts',
  'tests/domain/ui-service/subscribe.test.ts',
  'tests/entry/doctor-cli.test.ts',
  'tests/feishu-client.test.ts',
  'tests/feishu-user-mode.test.ts',
  'tests/memory-index-regen.test.ts',
  'tests/orch/web-bg-hold.test.ts',
  'tests/platform/app-update.test.ts',
  'tests/platform/interactive-builder.test.ts',
  'tests/platform-mock-adapter.test.ts',
  'tests/platform/tui-protocol.test.ts',
  'tests/platform/tui-transcript.test.ts',
  'tests/platform/zip-writer.test.ts',
  'tests/slack-message.test.ts',
  'tests/store/json-repository.test.ts',
  'tests/task-lint.test.ts',
  'tests/thread-contract.test.ts',
  'tests/threads/shell-template.test.ts',
  'tests/tui/markdown.test.ts',
  'tests/tui/render-output.test.ts',
  'tests/tui/slash-commands.test.ts',
  'tests/tui/turn-status.test.ts',
  'tests/tui/useDashboardData.test.ts',
  'tests/tui/useNotifications.test.ts',
  'tests/ui-service-compact.test.ts',
];
