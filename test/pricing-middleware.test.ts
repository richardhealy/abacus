import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { generateText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import type { PriceTable } from '../src/index.js';
import { InMemoryMeterSink, meteringMiddleware } from '../src/index.js';

const sampleUsage: LanguageModelV3Usage = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

function mockModel(modelId = 'mock/opus'): LanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId,
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: sampleUsage,
      warnings: [],
    }),
  });
}

// 42 input @ $15/M = 0.00063, 8 output @ $75/M = 0.0006 → total 0.00123.
const prices: PriceTable = { 'mock/opus': { input: 15, output: 75 } };

describe('meteringMiddleware pricing', () => {
  it('attaches computed cost to the record when a price table is given', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink, prices }),
    });

    await generateText({ model, prompt: 'hi' });

    expect(sink.records[0]?.cost).toBe(0.00123);
  });

  it('omits cost entirely when no price table is configured', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink }),
    });

    await generateText({ model, prompt: 'hi' });

    expect(sink.records[0]?.cost).toBeUndefined();
  });

  it('records without cost and warns once for an unpriced model', async () => {
    const onUnpricedModel = vi.fn();
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({
        sink,
        prices: { 'other-model': { input: 1, output: 1 } },
        onUnpricedModel,
      }),
    });

    await generateText({ model, prompt: 'one' });
    await generateText({ model, prompt: 'two' });

    expect(sink.count).toBe(2);
    expect(sink.records[0]?.cost).toBeUndefined();
    expect(sink.records[1]?.cost).toBeUndefined();
    expect(onUnpricedModel).toHaveBeenCalledOnce();
    expect(onUnpricedModel).toHaveBeenCalledWith('mock/opus');
  });

  it('sums cost across records via the sink rollup', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink, prices }),
    });

    await generateText({ model, prompt: 'one' });
    await generateText({ model, prompt: 'two' });
    await generateText({ model, prompt: 'three' });

    expect(sink.totalCost()).toBe(0.00369);
  });
});
