// REQ-CORE-012 — per-request batching loader: collects keys requested during one tick of the event
// loop and resolves them with a single repository call, so nested GraphQL fields never go N+1.
export type BatchFn<K, V> = (keys: readonly K[]) => Promise<ReadonlyMap<K, V>>;

interface Waiter<K, V> {
  key: K;
  resolve: (v: V | null) => void;
  reject: (e: unknown) => void;
}

export class BatchLoader<K, V> {
  private readonly cache = new Map<K, Promise<V | null>>();
  private pending: Array<Waiter<K, V>> = [];
  private scheduled = false;

  constructor(private readonly batch: BatchFn<K, V>) {}

  load(key: K): Promise<V | null> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const p = new Promise<V | null>((resolve, reject) => {
      this.pending.push({ key, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
    this.cache.set(key, p);
    return p;
  }

  loadMany(keys: readonly K[]): Promise<Array<V | null>> {
    return Promise.all(keys.map((k) => this.load(k)));
  }

  /** Seeds the cache with values already fetched by a list query so field resolvers hit no store. */
  prime(key: K, value: V): void {
    if (!this.cache.has(key)) this.cache.set(key, Promise.resolve(value));
  }

  private async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    this.scheduled = false;
    const keys = [...new Set(batch.map((b) => b.key))];
    try {
      const result = await this.batch(keys);
      for (const b of batch) b.resolve(result.get(b.key) ?? null);
    } catch (err) {
      for (const b of batch) b.reject(err);
    }
  }
}
