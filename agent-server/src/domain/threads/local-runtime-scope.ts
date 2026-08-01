// input:  scoped benchmark runtime event-bus policy
// output: async-local runtime scope accessors
// pos:    Propagates local thread policy across async callbacks
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { AsyncLocalStorage } from 'node:async_hooks';
import type { EventBus } from '../../events/index.js';

export interface LocalThreadRuntimeScope {
  eventBus: EventBus | null;
}

const runtimeScope = new AsyncLocalStorage<LocalThreadRuntimeScope>();

export function getLocalThreadRuntimeScope(): LocalThreadRuntimeScope | null {
  return runtimeScope.getStore() ?? null;
}

export function withLocalThreadRuntimeScope<T>(
  scope: LocalThreadRuntimeScope,
  action: () => Promise<T>,
): Promise<T> {
  return runtimeScope.run(scope, action);
}
