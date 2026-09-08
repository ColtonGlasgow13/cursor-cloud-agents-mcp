/** Tiny TTL cache. Used to keep /v1/models and /v1/repositories off the wire. */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface TtlCacheOptions {
  ttlMs: number;
  now?: () => number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor({ ttlMs, now = Date.now }: TtlCacheOptions) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
