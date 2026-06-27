/**
 * {@link RedisBudgetStore} — a multi-process {@link BudgetStore} backed by Redis.
 * Spend is incremented with the atomic `INCRBYFLOAT` (no overspend race across
 * processes) and each window bucket expires at the window boundary, so spend
 * resets with no cron. Written against the minimal structural {@link RedisLike}
 * client, so abacus adds no runtime Redis dependency.
 *
 * @module
 */
import type { BudgetScope } from './types.js';
import { roundUsd, scopeKey, type BudgetStore } from './store.js';
import { windowExpirySeconds } from './window.js';

/**
 * The minimal subset of Redis commands {@link RedisBudgetStore} needs. Declaring
 * it structurally (rather than depending on a concrete client) keeps abacus free
 * of a runtime Redis dependency: an `ioredis` client satisfies this shape
 * directly, and other clients (e.g. `node-redis`) can be passed via a thin
 * adapter.
 */
export interface RedisLike {
  /**
   * Atomically add `increment` to the number stored at `key` (creating it at
   * `0` first) and return the new value as a string. This is the command that
   * makes spend accounting concurrency-safe — the increment happens on the
   * server, so simultaneous callers cannot clobber each other.
   */
  incrbyfloat(key: string, increment: number): Promise<string>;
  /** Set a per-key TTL in seconds. */
  expire(key: string, seconds: number): Promise<unknown>;
  /** Read a key's value, or `null` when it does not exist. */
  get(key: string): Promise<string | null>;
}

/** Options for {@link RedisBudgetStore}. */
export interface RedisBudgetStoreOptions {
  /**
   * Prefix prepended to every key (before the `abacus:budget:` namespace),
   * useful for sharing a Redis instance across environments, e.g. `"prod"`.
   */
  keyPrefix?: string;
}

/**
 * A Redis-backed {@link BudgetStore}. Spend for each scope/window lives in one
 * key that the store increments atomically and expires at the window boundary.
 *
 * **Concurrency-safe:** {@link addSpend} uses `INCRBYFLOAT`, which is atomic on
 * the Redis server, so concurrent calls across many processes all land — no
 * overspend race. The window bucket is given a TTL that lands on the window's
 * end (re-set on each write, which is harmless because the boundary is fixed for
 * the window), so old buckets clean themselves up and the next window starts
 * fresh with no scheduled job.
 */
export class RedisBudgetStore implements BudgetStore {
  private readonly redis: RedisLike;
  private readonly keyPrefix: string | undefined;

  constructor(redis: RedisLike, options: RedisBudgetStoreOptions = {}) {
    this.redis = redis;
    this.keyPrefix = options.keyPrefix;
  }

  async addSpend(
    scope: BudgetScope,
    amount: number,
    at: number,
  ): Promise<number> {
    const key = this.key(scope, at);
    const total = await this.redis.incrbyfloat(key, amount);
    await this.redis.expire(key, windowExpirySeconds(scope.window, at));
    return roundUsd(Number(total));
  }

  async getSpend(scope: BudgetScope, at: number): Promise<number> {
    const raw = await this.redis.get(this.key(scope, at));
    return raw === null ? 0 : roundUsd(Number(raw));
  }

  private key(scope: BudgetScope, at: number): string {
    const base = scopeKey(scope, at);
    return this.keyPrefix === undefined ? base : `${this.keyPrefix}:${base}`;
  }
}
