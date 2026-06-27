import type { Attribution } from '../attribution/types.js';
import { roundUsd, type BudgetStore } from './store.js';
import type {
  Budget,
  BudgetLevel,
  BudgetScope,
  BudgetState,
} from './types.js';

/**
 * Which threshold `spent` has crossed for `budget`. Pure and deterministic.
 *
 * Thresholds are crossed at `>=` (spending exactly to a cap counts as crossed),
 * and `hard` is checked before `soft` so a budget with `spent >= hard` always
 * reports `'hard'` even if a soft limit also exists.
 */
export function budgetLevel(budget: Budget, spent: number): BudgetLevel {
  if (spent >= budget.hard) return 'hard';
  if (budget.soft !== undefined && spent >= budget.soft) return 'soft';
  return 'ok';
}

/**
 * Pair `budget` with `spent` into a {@link BudgetState}: the level it has
 * crossed and the fraction of its hard limit consumed. Pure — this is the
 * read-side value the policy engine (M4) maps to an action.
 */
export function evaluateBudget(budget: Budget, spent: number): BudgetState {
  const fraction = budget.hard > 0 ? roundUsd(spent / budget.hard) : 0;
  return {
    budget,
    spent,
    level: budgetLevel(budget, spent),
    fraction,
  };
}

/** The {@link BudgetScope} a budget accumulates spend against. */
function scopeOf(budget: Budget): BudgetScope {
  return {
    dimension: budget.dimension,
    key: budget.key,
    window: budget.window,
  };
}

export interface BudgetLedgerOptions {
  /** The durable store spend accumulates into. */
  store: BudgetStore;
  /** The budgets this ledger governs. */
  budgets: readonly Budget[];
  /**
   * Clock for choosing the current window bucket. Defaults to `Date.now`.
   * Injectable so tests can place spend in a chosen day/month deterministically.
   */
  now?: () => number;
}

/**
 * Ties attribution to budgets: given an attributed cost, it charges every budget
 * that the attribution falls under and reports each budget's resulting state.
 *
 * A budget `{ dimension: 'tenant', key: 'acme' }` applies to a call iff the
 * call's attribution carries `tenant: 'acme'`. One call can touch several
 * budgets at once (its tenant *and* its feature, say), each in its own window.
 * The ledger is the read/write surface the metering middleware and the policy
 * engine (M4) build on; deciding what to *do* when a level is crossed is the
 * policy engine's job, not the ledger's.
 */
export class BudgetLedger {
  private readonly store: BudgetStore;
  private readonly budgets: readonly Budget[];
  private readonly now: () => number;

  constructor(options: BudgetLedgerOptions) {
    this.store = options.store;
    this.budgets = options.budgets;
    this.now = options.now ?? Date.now;
  }

  /** The budgets whose dimension value matches `attribution`. */
  budgetsFor(attribution: Attribution | undefined): Budget[] {
    if (attribution === undefined) return [];
    return this.budgets.filter((b) => attribution[b.dimension] === b.key);
  }

  /**
   * Current state of every budget matching `attribution`, without charging.
   * Use it to decide whether a call may proceed before incurring its cost.
   */
  async check(
    attribution: Attribution | undefined,
    at: number = this.now(),
  ): Promise<BudgetState[]> {
    const matching = this.budgetsFor(attribution);
    return Promise.all(
      matching.map(async (budget) =>
        evaluateBudget(budget, await this.store.getSpend(scopeOf(budget), at)),
      ),
    );
  }

  /**
   * Add `cost` USD to every budget matching `attribution` and return their
   * resulting states. A zero (or negative) cost charges nothing and reads the
   * current state instead, so it never creates an empty bucket.
   */
  async charge(
    attribution: Attribution | undefined,
    cost: number,
    at: number = this.now(),
  ): Promise<BudgetState[]> {
    if (!(cost > 0)) return this.check(attribution, at);
    const matching = this.budgetsFor(attribution);
    return Promise.all(
      matching.map(async (budget) =>
        evaluateBudget(budget, await this.store.addSpend(scopeOf(budget), cost, at)),
      ),
    );
  }
}
