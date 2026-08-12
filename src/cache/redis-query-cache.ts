import { createHash, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { createClient } from "redis";

const COMMAND_TIMEOUT_MS = 75;
const LOCK_TTL_MS = 1_000;
const LOCK_WAIT_MS = 25;
const MAX_CACHE_VALUE_BYTES = 1 * 1_024 * 1_024;

export interface QueryCache {
  getOrLoad<T>(namespace: string, identity: string, loader: () => Promise<T>): Promise<T>;
}

export class RedisQueryCache implements QueryCache {
  private readonly client;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private errors = 0;
  private bypasses = 0;
  private getLatencyMs = 0;
  private getCount = 0;

  constructor(
    url: string,
    private readonly ttlMs: number,
    private readonly logger?: FastifyBaseLogger,
  ) {
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 250,
        reconnectStrategy: (retries) => Math.min(1_000, 50 * 2 ** Math.min(retries, 5)),
      },
    });
    this.client.on("error", (error) => {
      this.errors += 1;
      this.logger?.warn({ err: error }, "Redis query cache connection error");
    });
  }

  start(): void {
    if (!this.client.isOpen) {
      void this.client.connect().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit().catch(() => this.client.destroy());
    }
  }

  snapshot(): Record<string, number> {
    return {
      cacheHits: this.hits,
      cacheMisses: this.misses,
      cacheErrors: this.errors,
      cacheBypasses: this.bypasses,
      cacheGetCount: this.getCount,
      cacheAverageGetLatencyMs:
        this.getCount === 0 ? 0 : Math.round((this.getLatencyMs / this.getCount) * 100) / 100,
    };
  }

  async getOrLoad<T>(namespace: string, identity: string, loader: () => Promise<T>): Promise<T> {
    const digest = createHash("sha256").update(identity).digest("hex");
    const key = `logforge:v1:${namespace}:${digest}`;
    if (!this.client.isReady) {
      this.bypasses += 1;
      return loader();
    }

    const cached = await this.get<T>(key);
    if (cached.found) {
      this.hits += 1;
      return cached.value;
    }
    this.misses += 1;

    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing !== undefined) return existing;

    const loading = this.loadAndCache(key, loader);
    this.inFlight.set(key, loading);
    try {
      return await loading;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async loadAndCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const lockKey = `${key}:lock`;
    const token = randomUUID();
    let ownsLock = false;
    try {
      ownsLock = (await this.withTimeout(
        this.client.set(lockKey, token, { NX: true, PX: LOCK_TTL_MS }),
      )) === "OK";
      if (!ownsLock) {
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        const cached = await this.get<T>(key);
        if (cached.found) {
          this.hits += 1;
          return cached.value;
        }
      }
    } catch {
      this.errors += 1;
    }

    const value = await loader();
    try {
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized) <= MAX_CACHE_VALUE_BYTES) {
        await this.withTimeout(this.client.set(key, serialized, { PX: this.ttlMs }));
      } else {
        this.bypasses += 1;
      }
    } catch {
      this.errors += 1;
    } finally {
      if (ownsLock) {
        void this.client.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          { keys: [lockKey], arguments: [token] },
        ).catch(() => undefined);
      }
    }
    return value;
  }

  private async get<T>(key: string): Promise<{ found: true; value: T } | { found: false }> {
    const startedAt = performance.now();
    try {
      const serialized = await this.withTimeout(this.client.get(key));
      if (serialized === null) return { found: false };
      return { found: true, value: JSON.parse(serialized) as T };
    } catch {
      this.errors += 1;
      return { found: false };
    } finally {
      this.getCount += 1;
      this.getLatencyMs += performance.now() - startedAt;
    }
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Redis command timed out")), COMMAND_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
