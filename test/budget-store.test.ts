import { describe, expect, it } from 'vitest';
import type { BudgetScope } from '../src/index.js';
import { InMemoryBudgetStore, scopeKey } from '../src/index.js';

const acme: BudgetScope = { dimension: 'tenant', key: 'acme', window: 'daily' };
const JUN_27 = Date.UTC(2026, 5, 27);

describe('scopeKey', () => {
  it('namespaces by window, dimension, value, and bucket', () => {
    expect(
      scopeKey({ dimension: 'tenant', key: 'acme', window: 'monthly' }, JUN_27),
    ).toBe('abacus:budget:monthly:tenant:acme:2026-06');
    expect(scopeKey(acme, JUN_27)).toBe('abacus:budget:daily:tenant:acme:2026-06-27');
  });
});

describe('InMemoryBudgetStore', () => {
  it('accumulates spend and reads it back', async () => {
    const store = new InMemoryBudgetStore();
    expect(await store.addSpend(acme, 0.5, JUN_27)).toBe(0.5);
    expect(await store.addSpend(acme, 0.25, JUN_27)).toBe(0.75);
    expect(await store.getSpend(acme, JUN_27)).toBe(0.75);
  });

  it('reports zero spend for an untouched scope', async () => {
    const store = new InMemoryBudgetStore();
    expect(await store.getSpend(acme, JUN_27)).toBe(0);
  });

  it('isolates spend across windows so it resets at a boundary', async () => {
    const store = new InMemoryBudgetStore();
    const monthly: BudgetScope = { ...acme, window: 'monthly' };
    const jan = Date.UTC(2026, 0, 15);
    const feb = Date.UTC(2026, 1, 15);
    await store.addSpend(monthly, 5, jan);
    await store.addSpend(monthly, 3, feb);
    expect(await store.getSpend(monthly, jan)).toBe(5);
    expect(await store.getSpend(monthly, feb)).toBe(3);
  });

  it('keeps different dimension values in separate buckets', async () => {
    const store = new InMemoryBudgetStore();
    const globex: BudgetScope = { ...acme, key: 'globex' };
    await store.addSpend(acme, 5, JUN_27);
    await store.addSpend(globex, 2, JUN_27);
    expect(await store.getSpend(acme, JUN_27)).toBe(5);
    expect(await store.getSpend(globex, JUN_27)).toBe(2);
  });

  it('loses no increment under concurrent charges (no overspend race)', async () => {
    const store = new InMemoryBudgetStore();
    await Promise.all(
      Array.from({ length: 1_000 }, () => store.addSpend(acme, 0.001, JUN_27)),
    );
    expect(await store.getSpend(acme, JUN_27)).toBe(1);
  });

  it('rounds accumulated spend to nano-dollars (no float dust)', async () => {
    const store = new InMemoryBudgetStore();
    await store.addSpend(acme, 0.1, JUN_27);
    await store.addSpend(acme, 0.2, JUN_27);
    expect(await store.getSpend(acme, JUN_27)).toBe(0.3);
  });

  it('clears all accumulated spend', async () => {
    const store = new InMemoryBudgetStore();
    await store.addSpend(acme, 5, JUN_27);
    store.clear();
    expect(await store.getSpend(acme, JUN_27)).toBe(0);
  });
});
