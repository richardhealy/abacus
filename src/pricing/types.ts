/**
 * The pricing vocabulary: {@link ModelPrice} (a model's list price in USD per 1M
 * tokens), {@link PriceTable} (those prices keyed by model id), and {@link
 * CostBreakdown} (the per-category cost of one call). Plain data, kept separate
 * from the cost math in `cost.ts`, so a deployment can audit or override prices
 * without touching the arithmetic.
 *
 * @module
 */
import type { TokenUsage } from '../middleware/types.js';

/**
 * The list price for a single model, denominated in **US dollars per one million
 * tokens**. Keeping the unit fixed (USD / 1M tokens) is what makes the price
 * table auditable: every number here can be checked against a provider's
 * published rate card at a glance.
 *
 * Rates are per *category* of token, mirroring how providers actually bill:
 * fresh prompt tokens, cache reads, and completion tokens each have their own
 * line. Reasoning/thinking tokens are billed at the `output` rate (they are a
 * subset of output tokens), so they have no separate line here.
 */
export interface ModelPrice {
  /** USD per 1M fresh (uncached) input/prompt tokens. */
  input: number;
  /** USD per 1M output/completion tokens. */
  output: number;
  /**
   * USD per 1M input tokens served from the provider's prompt cache (a "cache
   * read"). Usually a steep discount on {@link ModelPrice.input}. When a
   * provider offers no cache discount, omit it and cached reads are billed at
   * the full `input` rate.
   */
  cachedInput?: number;
}

/**
 * A table of model list prices, keyed by model id. Lookups (see `priceFor`)
 * accept either a bare model id (`"claude-opus-4"`) or a provider-qualified one
 * (`"anthropic/claude-opus-4"`); the table itself is conventionally keyed by the
 * bare id.
 *
 * The table is plain data kept in config so cost math stays auditable: callers
 * can pass their own negotiated table to override the bundled list prices
 * without touching a line of code.
 */
export type PriceTable = Record<string, ModelPrice>;

/**
 * A deterministic, per-category breakdown of the cost of one metered call. All
 * amounts are in US dollars, rounded to nano-dollar precision so that summing
 * many small per-call costs stays stable and free of floating-point dust.
 */
export interface CostBreakdown {
  /** Cost of fresh (uncached) input tokens. */
  inputCost: number;
  /** Cost of input tokens served from the prompt cache. */
  cachedInputCost: number;
  /** Cost of output (completion) tokens, reasoning tokens included. */
  outputCost: number;
  /** `inputCost + cachedInputCost + outputCost`. */
  totalCost: number;
  /** Currency of every amount above. Always `"USD"`. */
  currency: 'USD';
}

/** Shorthand: anything that can be priced reports usage this way. */
export type { TokenUsage };
