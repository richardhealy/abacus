import type { AttributionDimension } from '../attribution/types.js';

/**
 * The time window over which spend accumulates before resetting to zero.
 *
 * A budget is always windowed: "$50/day for tenant acme" or "$1000/month for
 * the summarize feature". Spend accrues into the current window's bucket and a
 * new window starts a fresh count — see {@link windowKey}. Both boundaries are
 * computed in UTC so a window rolls over at the same instant everywhere.
 */
export type BudgetWindow = 'daily' | 'monthly';

/** The windows abacus supports, in a stable, iterable order. */
export const BUDGET_WINDOWS: readonly BudgetWindow[] = ['daily', 'monthly'];

/**
 * A spend limit for one attribution scope over one window. All amounts are in
 * US dollars, the same unit the price table and `MeterRecord.cost` use.
 *
 * A budget is keyed on a single attribution dimension and value — `{ dimension:
 * 'tenant', key: 'acme' }` budgets the tenant `acme`. The two thresholds drive
 * the policy engine (M4): crossing {@link Budget.soft} signals graceful
 * degradation (downshift / serve cache), crossing {@link Budget.hard} signals
 * refusal. `soft` is optional and, when set, must not exceed `hard`.
 */
export interface Budget {
  /** Which attribution axis this budget caps (tenant / feature / user). */
  dimension: AttributionDimension;
  /** The value on that axis the budget applies to, e.g. a tenant id `"acme"`. */
  key: string;
  /** The window spend accumulates over before resetting. */
  window: BudgetWindow;
  /**
   * Soft limit in USD. Once window spend reaches it, the budget is at the
   * `'soft'` level and the policy engine degrades (downshift / cache) rather
   * than refusing. Omit it for a hard-only budget.
   */
  soft?: number;
  /**
   * Hard limit in USD. Once window spend reaches it, the budget is at the
   * `'hard'` level and the policy engine refuses further spend.
   */
  hard: number;
}

/**
 * The scope a {@link BudgetStore} accumulates spend against: a dimension value
 * over a window. Derived from a {@link Budget} (it is the budget without its
 * limits), so the store stays a pure spend ledger and limit evaluation lives in
 * the {@link BudgetLedger}.
 */
export interface BudgetScope {
  dimension: AttributionDimension;
  key: string;
  window: BudgetWindow;
}

/**
 * Where the current window spend sits relative to a budget's thresholds.
 *
 * - `'ok'`   — under the soft limit (or there is no soft limit and under hard).
 * - `'soft'` — at or above soft but below hard: degrade, do not refuse.
 * - `'hard'` — at or above the hard limit: refuse.
 *
 * Thresholds are crossed at `>=`: spending exactly to the cap counts as crossed,
 * so the next call is governed accordingly.
 */
export type BudgetLevel = 'ok' | 'soft' | 'hard';

/**
 * A budget paired with the spend measured against it in the current window.
 * This is the read-side value the policy engine (M4) consumes: it answers "how
 * much of this budget is used and which threshold has it crossed" without
 * deciding what to do about it.
 */
export interface BudgetState {
  /** The budget being measured. */
  budget: Budget;
  /** Spend accumulated in the current window, USD. */
  spent: number;
  /** Which threshold the current spend has crossed. */
  level: BudgetLevel;
  /**
   * Fraction of the hard limit consumed (`spent / hard`). `>= 1` once the hard
   * limit is reached; a convenient single number for dashboards and alerting.
   */
  fraction: number;
}
