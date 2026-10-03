import type { AppInstance, AppTarget } from './types.ts';

/**
 * Bounds how many fresh application instances are alive at once and always
 * stops each instance after use. close() stops anything still alive, including
 * instances that finish starting after a check timed out.
 */
export class InstancePool {
  #active = 0;
  #waiters: (() => void)[] = [];
  #started = 0;
  #live = new Set<AppInstance>();
  #closed = false;

  readonly #target: AppTarget;
  readonly #maxConcurrent: number;

  constructor(target: AppTarget, maxConcurrent: number) {
    this.#target = target;
    this.#maxConcurrent = maxConcurrent;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('maxInstances must be a positive integer');
  }

  get startedCount(): number {
    return this.#started;
  }

  async withFresh<T>(fn: (app: AppInstance) => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      if (this.#closed) throw new Error('instance pool is closed');
      this.#started += 1;
      const app = await this.#target.startFresh();
      if (this.#closed) {
        await app.stop().catch(() => undefined);
        throw new Error('instance pool closed during start');
      }
      this.#live.add(app);
      try {
        return await fn(app);
      } finally {
        this.#live.delete(app);
        await app.stop().catch(() => undefined);
      }
    } finally {
      this.#release();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const live = [...this.#live];
    this.#live.clear();
    await Promise.all(live.map((app) => app.stop().catch(() => undefined)));
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#active -= 1;
  }
}
