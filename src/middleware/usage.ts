import type { LanguageModelV3Usage } from '@ai-sdk/provider';
import type { TokenUsage } from './types.js';

function n(value: number | undefined): number {
  return value ?? 0;
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
