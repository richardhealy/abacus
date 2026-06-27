/**
 * Token-usage normalization at the metering boundary. {@link normalizeUsage}
 * flattens the AI SDK's nested, partly-undefined usage shape into abacus's flat
 * {@link TokenUsage}, and {@link zeroUsage} is the neutral element used for
 * summing and as the fallback when a call reports no usage. Doing this once, here,
 * is what lets cost math and rollups downstream never guard for missing fields.
 *
 * @module
 */
import type { LanguageModelV3Usage } from '@ai-sdk/provider';
import type { TokenUsage } from './types.js';

function n(value: number | undefined): number {
  return value ?? 0;
}

/**
 * A {@link TokenUsage} with every count at `0`.
 *
 * The neutral element for summing usage, and the fallback when a call reports
 * no usage at all — e.g. a stream that closes without a `finish` part, so there
 * is nothing to normalize but the call still warrants a record.
 */
export function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
}

/**
 * Flatten the AI SDK's nested {@link LanguageModelV3Usage} into abacus's flat
 * {@link TokenUsage}.
 *
 * Providers do not all report the same fields, so this prefers the
 * provider-supplied totals and falls back to summing the components that are
 * present:
 *
 * - `inputTokens`  = `inputTokens.total` ?? (`noCache` + `cacheRead`)
 * - `outputTokens` = `outputTokens.total` ?? (`text` + `reasoning`)
 * - `totalTokens`  = `inputTokens` + `outputTokens`
 *
 * Missing counts normalize to `0`, never `undefined`.
 */
export function normalizeUsage(usage: LanguageModelV3Usage): TokenUsage {
  const cachedInputTokens = n(usage.inputTokens.cacheRead);
  const inputTokens =
    usage.inputTokens.total ?? n(usage.inputTokens.noCache) + cachedInputTokens;

  const reasoningTokens = n(usage.outputTokens.reasoning);
  const outputTokens =
    usage.outputTokens.total ?? n(usage.outputTokens.text) + reasoningTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens,
    reasoningTokens,
  };
}
