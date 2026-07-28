// input:  nothing (leaf module)
// output: conduitQueues, enqueue(), and enqueueAndWait()
// pos:    orch/ layer [S6-B]
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/**
 * Per-conduit serial Promise queue. Each conduit has at most one tail entry.
 * Consumers may call .has(conduitId) to check whether a queue is already running
 * (e.g. to show a hourglass reaction), and .delete(conduitId) to discard a
 * pending tail (e.g. !cancel).
 */
export const conduitQueues = new Map<string, Promise<void>>();

/**
 * Append fn to the conduit's serial queue.
 *
 * Returns true if a queue was already running for this conduit when enqueue()
 * was called (useful for showing backpressure indicators). Returns false if
 * this is the first entry for the conduit.
 *
 * The queue entry is automatically removed once fn resolves or rejects, so
 * the Map never accumulates stale entries for completed conduits.
 */
export function enqueue(conduitId: string, fn: () => Promise<void>): boolean {
  const hadExisting = conduitQueues.has(conduitId);
  const prev = conduitQueues.get(conduitId) || Promise.resolve();
  const next = prev.then(fn, fn);
  conduitQueues.set(conduitId, next);
  next.finally(() => {
    if (conduitQueues.get(conduitId) === next) conduitQueues.delete(conduitId);
  });
  return hadExisting;
}

/** Append work and resolve with its value while the underlying void queue remains failure-safe. */
export function enqueueAndWait<T>(conduitId: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    enqueue(conduitId, async () => {
      try {
        resolve(await fn());
      } catch (error) {
        reject(error);
      }
    });
  });
}
