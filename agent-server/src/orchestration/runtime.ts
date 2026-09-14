// input:  setOrchestrationRuntime(), called once by the composition root (entry/app.ts)
// output: the PlatformAdapter and EventBus every orchestration module needs but cannot construct
// pos:    orchestration's one runtime holder. Orchestration reaches outward (post a status
//         message, publish a session event) but is reached from places that hold neither handle —
//         a webhook, a scheduled job, a background run settling hours later. Before this, those
//         modules borrowed `domain/scheduling/job-registry`'s `ctx` service locator; that locator
//         stays, but it is now the scheduling domain's own, not orchestration's back door.
import type { PlatformAdapter } from '@platform/index.js';
import type { EventBus } from '@events/index.js';

export interface OrchestrationRuntime {
  /** The platform adapter. Null before boot wiring (and in unit tests that never set one). */
  adapter: PlatformAdapter | null;
  /** The process event bus. Null before boot wiring. */
  bus: EventBus | null;
}

const runtime: OrchestrationRuntime = { adapter: null, bus: null };

/**
 * Bind the runtime handles. Called once from `entry/app.ts`; tests call it to arm one seam.
 *
 * Fields are merged, not replaced, so a test that only wants a bus does not blank the adapter.
 */
export function setOrchestrationRuntime(next: Partial<OrchestrationRuntime>): void {
  if ('adapter' in next) runtime.adapter = next.adapter ?? null;
  if ('bus' in next) runtime.bus = next.bus ?? null;
}

/**
 * Read the runtime handles.
 *
 * Deliberately does NOT throw when unset: every reader here already had to tolerate an unwired
 * process — a null bus dropped the event (`bus?.publish(...)`), `wakeSession` logged "no adapter" and
 * returned — and a throw would turn those silent degradations into crashes on a path that runs
 * during boot and shutdown. The nullable fields keep each call site's existing tolerance visible
 * at the call site.
 */
export function getOrchestrationRuntime(): OrchestrationRuntime {
  return runtime;
}

/** Convenience reader for the common `const adapter = ...; if (!adapter) return;` shape. */
export function orchestrationAdapter(): PlatformAdapter | null {
  return runtime.adapter;
}

/** Convenience reader for the `bus?.publish(...)` shape. */
export function orchestrationBus(): EventBus | null {
  return runtime.bus;
}

/** Test hook: drop both handles. */
export function _resetOrchestrationRuntime(): void {
  runtime.adapter = null;
  runtime.bus = null;
}
