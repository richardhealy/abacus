import type { TokenUsage } from '../middleware/types.js';
import type { CostBreakdown, ModelPrice, PriceTable } from './types.js';

/** One billion — the scale at which costs are rounded (nano-dollars). */
const NANO = 1e9;

/**
 * Cost, in USD, of `tokens` priced at `ratePerMillion` USD per 1M tokens,
 * rounded to the nearest nano-dollar.
 *
 * Rounding to a fixed scale is what makes the math deterministic and auditable:
 * `tokens * rate / 1_000_000` in IEEE-754 leaves tiny dust (e.g.
 * `0.30000000000000004`) that accumulates over thousands of calls. Collapsing
 * each component to nano-dollar precision keeps rollups exact to nine decimals.
 */
function usd(tokens: number, ratePerMillion: number): number {
  return Math.round(((tokens * ratePerMillion) / 1_000_000) * NANO) / NANO;
}

/**
 * Look up the price for `modelId` in `table`.
 *
 * Tries an exact key match first, then falls back to the bare model id (the
 * segment after the last `/`), so a gateway-qualified id like
 * `"anthropic/claude-opus-4"` resolves against a table keyed by
 * `"claude-opus-4"`. Returns `undefined` when the model is not priced — callers
 * decide whether an unpriced model is an error.
 */
export function priceFor(
  modelId: string,
  table: PriceTable,
): ModelPrice | undefined {
  const exact = table[modelId];
  if (exact !== undefined) return exact;

  const slash = modelId.lastIndexOf('/');
  if (slash === -1) return undefined;
  return table[modelId.slice(slash + 1)];
}

/**
 * Compute the per-category {@link CostBreakdown} for `usage` at `price`.
 *
 * Cached input tokens are a subset of `inputTokens`, so they are billed
 * separately at the (discounted) cache rate and the remainder at the full input
 * rate. Reasoning tokens are a subset of `outputTokens` and are already covered
 * by the output rate, so they are not charged again.
 *
 * Pure and deterministic: the same usage and price always yield the same
 * numbers.
 */
export function costOf(usage: TokenUsage, price: ModelPrice): CostBreakdown {
  const cacheRate = price.cachedInput ?? price.input;
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens;

  const inputCost = usd(uncachedInputTokens, price.input);
  const cachedInputCost = usd(usage.cachedInputTokens, cacheRate);
  const outputCost = usd(usage.outputTokens, price.output);

  return {
    inputCost,
    cachedInputCost,
    outputCost,
    totalCost:
      Math.round((inputCost + cachedInputCost + outputCost) * NANO) / NANO,
    currency: 'USD',
  };
}

/**
 * Resolve the price for `modelId` from `table` and compute the cost of `usage`.
 * Returns `undefined` when the model is not priced.
 *
 * A convenience over `priceFor` + `costOf` for the common case of pricing a
 * metered call straight from a table.
 */
export function computeCost(
  modelId: string,
  usage: TokenUsage,
  table: PriceTable,
): CostBreakdown | undefined {
  const price = priceFor(modelId, table);
  return price === undefined ? undefined : costOf(usage, price);
}
