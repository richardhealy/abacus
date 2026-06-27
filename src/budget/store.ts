/**
 * The {@link BudgetStore} seam — a durable counter of spend per scope and window,
 * where Redis (or another backend) plugs in, mirroring how {@link MeterSink}
 * abstracts the metering destination — plus the shared key/rounding helpers
 * ({@link scopeKey}, {@link roundUsd}). The store stays a dumb, concurrency-safe
 * spend ledger; evaluating limits against it is the {@link BudgetLedger}'s job.
 *
 * @module
 */
import type { BudgetScope } from './types.js';
import { windowKey } from './window.js';

/** One billion — the scale spend is rounded to (nano-dollars), as in pricing. */
const NANO = 1e9;

/**
 * Round a USD amount to nano-dollar precision, matching how per-call cost is
 * rounded. Keeps accumulated spend stable when a store adds many small amounts
 * (or a backend like Redis `INCRBYFLOAT` returns float dust).
 */
export function roundUsd(amount: number): number {
  return Math.round(amount * NANO) / NANO;
}

/**
 * The storage key for a scope's spend in the window containing `at`.
 *
 * Namespaced and fully qualified by window / dimension / value / bucket so two
 * budgets never collide and a durable backend (Redis) can scan or expire by
 * prefix. Example: `abacus:budget:monthly:tenant:acme:2026-06`.
 */
export function scopeKey(scope: BudgetScope, at: number): string {
  const bucket = windowKey(scope.window, at);
  return `abacus:budget:${scope.window}:${scope.dimension}:${scope.key}:${bucket}`;
}

/**
 * A durable counter of spend per budget scope and window. The seam where a
 * Redis (or other) backend plugs in, mirroring how {@link MeterSink} abstracts
 * the metering destination.
 *
 * The single hard requirement is **concurrency safety**: {@link addSpend} must
 * be atomic so two simultaneous calls can never lose an increment — the
 * overspend race the spec calls out. {@link InMemoryBudgetStore} gets this from
 * Node's single-threaded execution; {@link RedisBudgetStore} from the atomic
 * `INCRBYFLOAT` command.
 */
export interface BudgetStore {
  /**
   * Atomically add `amount` USD to the scope's spend for the window containing
   * `at`, returning the new window total. Concurrent calls must all be
   * reflected — no lost updates.
   */
  addSpend(scope: BudgetScope, amount: number, at: number): Promise<number>;
  /** Current spend, USD, for the window containing `at` (`0` if none). */
  getSpend(scope: BudgetScope, at: number): Promise<number>;
}
