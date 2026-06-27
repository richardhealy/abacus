import type { LanguageModelV3Usage } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { normalizeUsage } from '../src/index.js';

function usage(
  input: Partial<LanguageModelV3Usage['inputTokens']>,
  output: Partial<LanguageModelV3Usage['outputTokens']>,
): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
      ...input,
    },
    outputTokens: {
      total: undefined,
      text: undefined,
      reasoning: undefined,
      ...output,
    },
  };
}

describe('normalizeUsage', () => {
  it('flattens provider-reported totals', () => {
    const result = normalizeUsage(
      usage({ total: 100, cacheRead: 30 }, { total: 40, reasoning: 12 }),
    );

    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cachedInputTokens: 30,
      reasoningTokens: 12,
    });
  });

  it('defaults every missing field to 0', () => {
    const result = normalizeUsage(usage({}, {}));

    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('falls back to summing components when totals are absent', () => {
    const result = normalizeUsage(
      usage({ noCache: 70, cacheRead: 30 }, { text: 25, reasoning: 5 }),
    );

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(30);
    expect(result.totalTokens).toBe(130);
    expect(result.cachedInputTokens).toBe(30);
    expect(result.reasoningTokens).toBe(5);
  });

  it('prefers an explicit total over component sums', () => {
    const result = normalizeUsage(
      usage({ total: 100, noCache: 999 }, { total: 40, text: 999 }),
    );

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(40);
  });
});
