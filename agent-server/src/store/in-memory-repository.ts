import { AsyncMutex } from '@core/async-mutex.js';

export class InMemoryRepository<T> {
  private data: T;
  private readonly mutex = new AsyncMutex();

  constructor(private readonly defaultFactory: () => T) {
    this.data = defaultFactory();
  }

  async read(): Promise<T> {
    return this.data;
  }

  async write(next: T): Promise<void> {
    this.data = next;
  }

  async mutate<R>(fn: (cur: T) => { next: T; result: R }): Promise<R> {
    return this.mutex.run(async () => {
      const { next, result } = fn(this.data);
      this.data = next;
      return result;
    });
  }

  /** No-op: there is no external state to invalidate. */
  invalidate(): void {
    // intentional no-op
  }
}
