/**
 * The policy vocabulary (M4): the {@link Policy} an operator configures (a {@link
 * PolicyRule} per budget level) and the {@link PolicyAction} the engine produces
 * (allow / downshift / cache / refuse, each carrying the {@link BudgetState} that
 * triggered it). Both are discriminated unions, so {@link decide} is total and
 * the middleware can switch on the result exhaustively.
 *
 * @module
 */
import type { BudgetState } from '../budget/types.js';

/**
 * The decision the policy engine reaches for a single call: what the metering
 * middleware should *do* given the budgets the call falls under.
 *
 * It is the spec's `allow / downshift-to-X / cache / refuse`, modelled as a
 * discriminated union on `type`. The decision is pure — {@link decide} computes
 * it from budget state and the request alone — and the middleware (a later
 * increment) is the only part that executes it. Keeping the two apart is the
 * spec's observation/enforcement split: deciding is testable in isolation,
 * executing has the side effects.
 */
export type PolicyAction =
  | AllowAction
  | DownshiftAction
  | CacheAction
  | RefuseAction;

/** Proceed with the call as requested — no budget threshold was crossed. */
export interface AllowAction {
  type: 'allow';
}

/**
 * Proceed, but against a cheaper model than the caller requested — the spec's
 * "Opus → Haiku via the Gateway" downshift. The middleware swaps the model id
 * before delegating; everything else about the call is unchanged.
 */
export interface DownshiftAction {
  type: 'downshift';
  /** The model id to call instead of the requested one. */
  model: string;
  /** The model id the caller originally asked for. */
  from: string;
  /** Human-readable explanation, for tracing and logs. */
  reason: string;
  /** The budget whose level drove the decision. */
  trigger: BudgetState;
}

/**
 * Serve a cached response instead of calling the model at all — zero marginal
 * spend. The policy only *decides* to cache; supplying the cached value is the
 * caller's / middleware's concern (abacus does not own a cache).
 */
export interface CacheAction {
  type: 'cache';
  reason: string;
  trigger: BudgetState;
}

/**
 * Refuse the call. The middleware turns this into a clean, typed error rather
 * than letting the (over-budget) spend happen — the spec's hard-limit behavior.
 */
export interface RefuseAction {
  type: 'refuse';
  reason: string;
  trigger: BudgetState;
}

/**
 * How to pick the replacement model for a {@link DownshiftRule}, given the model
 * the call requested. Three equivalent, auditable forms:
 *
 * - a **string** — always downshift to this one model;
 * - a **record** — map a requested model id to its cheaper replacement (the
 *   declarative, auditable form: `{ 'anthropic/claude-opus-4':
 *   'anthropic/claude-haiku-4' }`); models not in the map are not downshifted;
 * - a **function** — compute the replacement (return `undefined` for "no cheaper
 *   model available").
 *
 * Whichever form, resolution is pure — see {@link resolveDownshift}. When it
 * yields no usable target (no entry, `undefined`, or the same model), the
 * downshift rule falls through to its {@link DownshiftRule.else}.
 */
export type Downshift =
  | string
  | Record<string, string>
  | ((modelId: string) => string | undefined);

/**
 * What to do at one budget level. Reused for both the soft and hard levels so
 * the engine has a single rule shape to evaluate. Each non-`allow` rule may
 * carry a `reason` that overrides the engine's generated explanation — useful
 * for a refusal message a caller will surface to a user.
 */
export type PolicyRule =
  | AllowRule
  | CacheRule
  | RefuseRule
  | DownshiftRule;

/** Do nothing — let the call through. The no-op level rule. */
export interface AllowRule {
  kind: 'allow';
}

/** Serve from cache at this level. */
export interface CacheRule {
  kind: 'cache';
  reason?: string;
}

/** Refuse the call at this level. */
export interface RefuseRule {
  kind: 'refuse';
  reason?: string;
}

/**
 * Downshift to a cheaper model at this level. If no cheaper model resolves for
 * the requested model (see {@link Downshift}), the engine applies {@link else}
 * instead — defaulting to `allow`, so a budget that can't be degraded simply
 * proceeds rather than failing closed. Set `else` to `{ kind: 'refuse' }` to
 * fail closed when no downshift target exists.
 */
export interface DownshiftRule {
  kind: 'downshift';
  to: Downshift;
  reason?: string;
  else?: PolicyRule;
}

/**
 * A cost-governance policy: what to do as a call's budgets tighten.
 *
 * The engine evaluates the most severe budget level the call has crossed and
 * applies the matching rule. Both fields are optional; the defaults encode the
 * spec's headline behavior conservatively — observe at soft (the operator must
 * opt into downshift/cache by naming a target), refuse at hard.
 */
export interface Policy {
  /** Rule for the `'soft'` level. Defaults to `{ kind: 'allow' }` (observe). */
  soft?: PolicyRule;
  /** Rule for the `'hard'` level. Defaults to `{ kind: 'refuse' }`. */
  hard?: PolicyRule;
}

/**
 * The request facts the policy decision can depend on. Attribution is *not*
 * here: which budgets a call falls under is resolved upstream (by the
 * {@link BudgetLedger}) and arrives as the {@link BudgetState}s passed to
 * {@link decide}. All the decision itself needs is the requested model, so it
 * can choose a downshift target.
 */
export interface PolicyRequest {
  /** The model id the call requested, e.g. `"anthropic/claude-opus-4"`. */
  modelId: string;
}
