import type { PriceTable } from './types.js';

/**
 * Bundled list prices, in **USD per 1M tokens**, keyed by bare model id.
 *
 * These mirror published provider rate cards and exist so the package works out
 * of the box, but they are deliberately plain data: deployments with negotiated
 * rates (or newer models) pass their own {@link PriceTable} to override this
 * without code changes. Treat this table as a starting point and verify it
 * against your provider's current pricing — that verification is the whole point
 * of keeping the numbers in one auditable place.
 *
 * `cachedInput` is the prompt-cache *read* rate. Cache *writes* are not modeled
 * separately yet; they are billed at the standard input rate.
 */
export const defaultPrices: PriceTable = {
  // --- Anthropic Claude ---
  'claude-opus-4': { input: 15, output: 75, cachedInput: 1.5 },
  'claude-sonnet-4': { input: 3, output: 15, cachedInput: 0.3 },
  'claude-haiku-4': { input: 0.8, output: 4, cachedInput: 0.08 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cachedInput: 0.08 },

  // --- OpenAI ---
  'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cachedInput: 0.075 },

  // --- Google Gemini ---
  'gemini-2.5-pro': { input: 1.25, output: 10, cachedInput: 0.31 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cachedInput: 0.075 },
};
