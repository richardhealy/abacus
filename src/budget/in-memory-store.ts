/**
 * {@link InMemoryBudgetStore} — a {@link BudgetStore} backed by a `Map`.
 * Concurrency-safe by construction: it reads and writes spend in one synchronous
 * step, so under Node's event loop concurrent charges can't lose an increment.
 * The reference store for tests and single-process use; production swaps in
 * {@link RedisBudgetStore} behind the same interface.
 *
 * @module
 */
import type { BudgetScope } from './types.js';
import { roundUsd, scopeKey, type BudgetStore } from './store.js';

/**
 * A {@link BudgetStore} that holds spend in a `Map`. The reference store for
 * tests, the offline example, and single-process deployments; production swaps
 * in {@link RedisBudgetStore} without any other change.
 *
 * **Concurrency-safe by construction.** {@link addSpend} reads and writes in one
 * synchronous step with no `await` in between, so under Node's single-threaded
 * event loop two concurrent callers can never interleave and lose an
 * increment — the overspend race. A thousand simultaneous charges sum exactly.
 */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly spend = new Map<string, number>();

  addSpend(scope: BudgetScope, amount: number, at: number): Promise<number> {
    const key = scopeKey(scope, at);
    const next = roundUsd((this.spend.get(key) ?? 0) + amount);
    this.spend.set(key, next);
    return Promise.resolve(next);
  }

  getSpend(scope: BudgetScope, at: number): Promise<number> {
    return Promise.resolve(this.spend.get(scopeKey(scope, at)) ?? 0);
  }

  /** Discard all accumulated spend. */
  clear(): void {
    this.spend.clear();
  }
}
