import { describe, expect, it } from 'vitest';
import type { BudgetScope, RedisLike } from '../src/index.js';
import { RedisBudgetStore } from '../src/index.js';

/**
 * A tiny in-memory stand-in for a Redis client implementing only the commands
 * {@link RedisBudgetStore} uses. `incrbyfloat` adds synchronously, modelling the
 * atomicity a real Redis server provides — so concurrent callers cannot lose an
 * increment.
 */
class FakeRedis implements RedisLike {
  readonly values = new Map<string, number>();
  readonly ttl = new Map<string, number>();

  incrbyfloat(key: string, increment: number): Promise<string> {
    const next = (this.values.get(key) ?? 0) + increment;
    this.values.set(key, next);
    return Promise.resolve(String(next));
  }

  expire(key: string, seconds: number): Promise<number> {
    this.ttl.set(key, seconds);
    return Promise.resolve(1);
  }

  get(key: string): Promise<string | null> {
    const v = this.values.get(key);
    return Promise.resolve(v === undefined ? null : String(v));
  }
}

const acme: BudgetScope = { dimension: 'tenant', key: 'acme', window: 'daily' };
const JUN_27 = Date.UTC(2026, 5, 27);

describe('RedisBudgetStore', () => {
  it('increments spend atomically and reads it back', async () => {
    const redis = new FakeRedis();
    const store = new RedisBudgetStore(redis);
    expect(await store.addSpend(acme, 0.5, JUN_27)).toBe(0.5);
    expect(await store.addSpend(acme, 0.25, JUN_27)).toBe(0.75);
    expect(await store.getSpend(acme, JUN_27)).toBe(0.75);
  });

  it('reports zero for a key that does not exist', async () => {
    const store = new RedisBudgetStore(new FakeRedis());
    expect(await store.getSpend(acme, JUN_27)).toBe(0);
  });

  it('sets the bucket TTL to the window boundary', async () => {
    const redis = new FakeRedis();
    const store = new RedisBudgetStore(redis);
    const monthly: BudgetScope = { ...acme, window: 'monthly' };
    await store.addSpend(monthly, 1, Date.UTC(2026, 5, 1));
    const [ttl] = [...redis.ttl.values()];
    expect(ttl).toBe(30 * 86_400); // whole of June
  });

  it('rounds Redis float results to nano-dollars', async () => {
    const redis = new FakeRedis();
    const store = new RedisBudgetStore(redis);
    await store.addSpend(acme, 0.1, JUN_27);
    expect(await store.addSpend(acme, 0.2, JUN_27)).toBe(0.3);
  });

  it('loses no increment under concurrent charges (no overspend race)', async () => {
    const store = new RedisBudgetStore(new FakeRedis());
    await Promise.all(
      Array.from({ length: 1_000 }, () => store.addSpend(acme, 0.001, JUN_27)),
    );
    expect(await store.getSpend(acme, JUN_27)).toBe(1);
  });

  it('applies a key prefix when configured', async () => {
    const redis = new FakeRedis();
    const store = new RedisBudgetStore(redis, { keyPrefix: 'prod' });
    await store.addSpend(acme, 1, JUN_27);
    const [key] = [...redis.values.keys()];
    expect(key).toBe('prod:abacus:budget:daily:tenant:acme:2026-06-27');
  });
});
