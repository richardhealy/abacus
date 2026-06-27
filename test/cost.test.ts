import { describe, expect, it } from 'vitest';
import type { ModelPrice, TokenUsage } from '../src/index.js';
import {
  computeCost,
  costOf,
  defaultPrices,
  priceFor,
} from '../src/index.js';

/** Build a TokenUsage with sensible zero defaults. */
function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    ...partial,
  };
}

const opus: ModelPrice = { input: 15, output: 75, cachedInput: 1.5 };

describe('priceFor', () => {
  it('resolves an exact key', () => {
    expect(priceFor('claude-opus-4', defaultPrices)).toEqual(
      defaultPrices['claude-opus-4'],
    );
  });

  it('falls back to the bare model id of a provider-qualified id', () => {
    expect(priceFor('anthropic/claude-opus-4', defaultPrices)).toEqual(
      defaultPrices['claude-opus-4'],
    );
  });

  it('uses only the last path segment for the fallback', () => {
    expect(priceFor('gateway/openai/gpt-4o', defaultPrices)).toEqual(
      defaultPrices['gpt-4o'],
    );
  });

  it('returns undefined for an unknown model', () => {
    expect(priceFor('no-such-model', defaultPrices)).toBeUndefined();
    expect(priceFor('vendor/no-such-model', defaultPrices)).toBeUndefined();
  });

  it('prefers an exact key over the bare-id fallback', () => {
    const table = {
      'anthropic/claude-opus-4': { input: 1, output: 2 },
      'claude-opus-4': { input: 99, output: 99 },
    };
    expect(priceFor('anthropic/claude-opus-4', table)).toEqual({
      input: 1,
      output: 2,
    });
  });
});

describe('costOf', () => {
  it('charges input and output tokens at their respective rates', () => {
    expect(costOf(usage({ inputTokens: 1000, outputTokens: 500 }), opus)).toEqual(
      {
        inputCost: 0.015,
        cachedInputCost: 0,
        outputCost: 0.0375,
        totalCost: 0.0525,
        currency: 'USD',
      },
    );
  });

  it('bills cached input tokens at the discounted cache rate', () => {
    // 600 fresh @ $15/M + 400 cached @ $1.5/M + 500 output @ $75/M.
    const result = costOf(
      usage({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 500 }),
      opus,
    );
    expect(result.inputCost).toBe(0.009);
    expect(result.cachedInputCost).toBe(0.0006);
    expect(result.outputCost).toBe(0.0375);
    expect(result.totalCost).toBe(0.0471);
  });

  it('does not charge reasoning tokens again (they are part of output)', () => {
    const withReasoning = costOf(
      usage({ inputTokens: 100, outputTokens: 500, reasoningTokens: 200 }),
      opus,
    );
    const withoutReasoning = costOf(
      usage({ inputTokens: 100, outputTokens: 500 }),
      opus,
    );
    expect(withReasoning.totalCost).toBe(withoutReasoning.totalCost);
  });

  it('bills cached reads at the input rate when no cache discount is set', () => {
    const flat: ModelPrice = { input: 10, output: 20 };
    const result = costOf(
      usage({ inputTokens: 1000, cachedInputTokens: 300 }),
      flat,
    );
    // 700 @ 10 + 300 @ 10 == 1000 @ 10.
    expect(result.inputCost).toBe(0.007);
    expect(result.cachedInputCost).toBe(0.003);
    expect(result.totalCost).toBe(0.01);
  });

  it('is deterministic and free of floating-point dust across many calls', () => {
    const one = costOf(usage({ inputTokens: 333, outputTokens: 111 }), opus);
    const summed = Array.from({ length: 3 }).reduce<number>(
      (acc) => acc + one.totalCost,
      0,
    );
    expect(summed).toBe(one.totalCost * 3);
    expect(Math.round(summed * 1e9)).toBe(summed * 1e9);
  });
});

describe('computeCost', () => {
  it('resolves a price from the table and computes the cost', () => {
    const result = computeCost(
      'anthropic/claude-sonnet-4',
      usage({ inputTokens: 1000, outputTokens: 1000 }),
      defaultPrices,
    );
    expect(result?.totalCost).toBe(0.018); // 1000@$3/M + 1000@$15/M
  });

  it('returns undefined for an unpriced model', () => {
    expect(
      computeCost('unknown-model', usage({ inputTokens: 10 }), defaultPrices),
    ).toBeUndefined();
  });
});

describe('defaultPrices', () => {
  it('quotes positive input and output rates for every model', () => {
    for (const [model, price] of Object.entries(defaultPrices)) {
      expect(price.input, model).toBeGreaterThan(0);
      expect(price.output, model).toBeGreaterThan(0);
      if (price.cachedInput !== undefined) {
        expect(price.cachedInput, model).toBeLessThanOrEqual(price.input);
      }
    }
  });
});
