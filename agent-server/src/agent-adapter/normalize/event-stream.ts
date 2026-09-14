export interface EventStream<T> {
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  close: () => void;
  /** True once close() has run. `push` is a silent no-op from then on, so anything that needs to
   *  know whether its event actually landed — an out-of-band producer, say — must ask first. */
  isClosed: () => boolean;
}

export function createEventStream<T>(): EventStream<T> {
  const buffer: T[] = [];
  const waiters: Array<(value: IteratorResult<T>) => void> = [];
  let closed = false;

  function push(value: T): void {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value, done: false });
    else buffer.push(value);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w({ value: undefined as unknown as T, done: true });
    }
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<T>> {
          close();
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        },
      };
    },
  };

  return { iterable, push, close, isClosed: () => closed };
}
