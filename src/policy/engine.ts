/**
 * The policy engine (M4): the pure {@link decide} that turns the budget states a
 * call falls under into a {@link PolicyAction} — the spec's
 * `(budget state, request) → action`. It picks the {@link mostSevere} crossed
 * level and applies that level's rule. Side-effect free and never throws, so it
 * is unit-testable per branch; the enforcement middleware is the only part that
 * executes the action.
 *
 * @module
 */
import type { BudgetLevel, BudgetState } from '../budget/types.js';
import type {
  Downshift,
  Policy,
  PolicyAction,
  PolicyRequest,
  PolicyRule,
} from './types.js';

/** Severity order for budget levels, so the worst one can be compared. */
const LEVEL_RANK: Record<BudgetLevel, number> = { ok: 0, soft: 1, hard: 2 };

/** The level rule the engine falls back to when a {@link Policy} omits one. */
export const DEFAULT_SOFT_RULE: PolicyRule = { kind: 'allow' };
/** Hard-limit default: refuse. The spec's fail-closed behavior at the cap. */
export const DEFAULT_HARD_RULE: PolicyRule = { kind: 'refuse' };

/**
 * The most severe of `states` — the budget closest to (or furthest past) its
 * cap, which governs the call. Severity is by level first (`hard` > `soft` >
 * `ok`), then by fraction of the hard limit so ties resolve deterministically
 * to the most-consumed budget. Returns `undefined` only for an empty list (a
 * call under no budgets). Pure.
 */
export function mostSevere(
  states: readonly BudgetState[],
): BudgetState | undefined {
  let worst: BudgetState | undefined;
  for (const state of states) {
    if (worst === undefined || isWorse(state, worst)) worst = state;
  }
  return worst;
}

function isWorse(a: BudgetState, b: BudgetState): boolean {
  const byLevel = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
  return byLevel > 0 || (byLevel === 0 && a.fraction > b.fraction);
}

/**
 * Resolve a {@link Downshift} to a concrete replacement model for `modelId`, or
 * `undefined` when there is none. Pure; handles all three downshift forms
 * (string / record / function). A target equal to `modelId` is treated as no
 * downshift, so a self-mapping never loops.
 */
export function resolveDownshift(
  to: Downshift,
  modelId: string,
): string | undefined {
  const target =
    typeof to === 'function'
      ? to(modelId)
      : typeof to === 'string'
        ? to
        : to[modelId];
  return target === modelId ? undefined : target;
}

/**
 * A concise, human-readable description of a budget state, e.g.
 * `tenant 'acme' daily budget at hard limit ($50.00 of $50.00)`. Used to build
 * the `reason` on degrade/refuse actions (and reusable for logs and traces).
 * The denominator is the limit for the crossed level — the soft limit at the
 * soft level, the hard limit at the hard level.
 */
export function describeBudgetState(state: BudgetState): string {
  const { budget, level, spent } = state;
  const limit =
    level === 'soft' && budget.soft !== undefined ? budget.soft : budget.hard;
  return (
    `${budget.dimension} '${budget.key}' ${budget.window} budget ` +
    `at ${level} limit ($${spent.toFixed(2)} of $${limit.toFixed(2)})`
  );
}

/**
 * Decide what to do with a call, purely, from the budgets it falls under and the
 * model it requested — the spec's `(budget state, request) → action`.
 *
 * The engine finds the most severe budget level the call has crossed and applies
 * the policy's rule for that level (`policy.soft` / `policy.hard`, each with a
 * conservative default). A call under no budgets, or whose budgets are all `ok`,
 * is always allowed. The result is a {@link PolicyAction} the middleware
 * executes; this function has no side effects and never throws.
 */
export function decide(
  policy: Policy,
  states: readonly BudgetState[],
  request: PolicyRequest,
): PolicyAction {
  const worst = mostSevere(states);
  if (worst === undefined || worst.level === 'ok') return { type: 'allow' };

  const rule =
    worst.level === 'hard'
      ? (policy.hard ?? DEFAULT_HARD_RULE)
      : (policy.soft ?? DEFAULT_SOFT_RULE);

  return applyRule(rule, worst, request);
}

/** Turn one level rule into a concrete action against the triggering budget. */
function applyRule(
  rule: PolicyRule,
  trigger: BudgetState,
  request: PolicyRequest,
): PolicyAction {
  switch (rule.kind) {
    case 'allow':
      return { type: 'allow' };
    case 'cache':
      return {
        type: 'cache',
        reason: rule.reason ?? `${describeBudgetState(trigger)}: serving cache`,
        trigger,
      };
    case 'refuse':
      return {
        type: 'refuse',
        reason: rule.reason ?? `${describeBudgetState(trigger)}: refused`,
        trigger,
      };
    case 'downshift': {
      const model = resolveDownshift(rule.to, request.modelId);
      if (model === undefined) {
        // No cheaper model for this request — fall through to the else rule
        // (default: allow, so a non-downshiftable call still proceeds).
        return applyRule(rule.else ?? { kind: 'allow' }, trigger, request);
      }
      return {
        type: 'downshift',
        model,
        from: request.modelId,
        reason:
          rule.reason ??
          `${describeBudgetState(trigger)}: downshifted to ${model}`,
        trigger,
      };
    }
  }
}
