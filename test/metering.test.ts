import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { generateText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import type { MeterRecord, MeterSink } from '../src/index.js';
import { InMemoryMeterSink, meteringMiddleware } from '../src/index.js';

const sampleUsage: LanguageModelV3Usage = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

function mockModel(
  overrides: { provider?: string; modelId?: string; usage?: LanguageModelV3Usage } = {},
): LanguageModelV3 {
  return new MockLanguageModelV3({
    provider: overrides.provider ?? 'mock',
    modelId: overrides.modelId ?? 'mock/opus',
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: overrides.usage ?? sampleUsage,
      warnings: [],
    }),
  });
}

/** A clock that advances by `step` ms on each call, starting at `start`. */
function fakeClock(start: number, step: number): () => number {
  let t = start;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

describe('meteringMiddleware', () => {
  it('records token usage, latency, and attribution for a wrapped call', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink, now: fakeClock(1000, 250) }),
    });

    const { text } = await generateText({ model, prompt: 'hi' });

    expect(text).toBe('ok');
    expect(sink.count).toBe(1);
    expect(sink.records[0]).toEqual<MeterRecord>({
      modelId: 'mock/opus',
      provider: 'mock',
      timestamp: 1250,
      latencyMs: 250,
      usage: {
        inputTokens: 42,
        outputTokens: 8,
        totalTokens: 50,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    });
  });

  it('returns the underlying result unchanged', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink }),
    });

    const result = await generateText({ model, prompt: 'hi' });

    expect(result.text).toBe('ok');
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(8);
  });

  it('meters every call across repeated invocations', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink }),
    });

    await generateText({ model, prompt: 'one' });
    await generateText({ model, prompt: 'two' });
    await generateText({ model, prompt: 'three' });

    expect(sink.count).toBe(3);
    expect(sink.totals().totalTokens).toBe(150);
  });

  it('never breaks the wrapped call when the sink throws', async () => {
    const onError = vi.fn();
    const boom = new Error('sink down');
    const throwingSink: MeterSink = {
      record() {
        throw boom;
      },
    };
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink: throwingSink, onError }),
    });

    const { text } = await generateText({ model, prompt: 'hi' });

    expect(text).toBe('ok');
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(boom, expect.objectContaining({ modelId: 'mock/opus' }));
  });

  it('awaits an async sink before the call resolves', async () => {
    const recorded: MeterRecord[] = [];
    const asyncSink: MeterSink = {
      async record(record) {
        await Promise.resolve();
        recorded.push(record);
      },
    };
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink: asyncSink }),
    });

    await generateText({ model, prompt: 'hi' });

    expect(recorded).toHaveLength(1);
  });
});

describe('meteringMiddleware attribution', () => {
  it('tags a record from per-call providerOptions', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink }),
    });

    await generateText({
      model,
      prompt: 'hi',
      providerOptions: { abacus: { tenant: 'acme', feature: 'chat', user: 'u_1' } },
    });

    expect(sink.records[0]?.attribution).toEqual({
      tenant: 'acme',
      feature: 'chat',
      user: 'u_1',
    });
  });

  it('leaves attribution undefined for an untagged call', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink }),
    });

    await generateText({ model, prompt: 'hi' });

    expect(sink.records[0]?.attribution).toBeUndefined();
  });

  it('merges a static default with per-call attribution, per-call winning', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({
        sink,
        attribution: { feature: 'chat', tenant: 'default' },
      }),
    });

    await generateText({
      model,
      prompt: 'hi',
      providerOptions: { abacus: { tenant: 'acme', user: 'u_1' } },
    });

    expect(sink.records[0]?.attribution).toEqual({
      tenant: 'acme',
      feature: 'chat',
      user: 'u_1',
    });
  });

  it('applies the static default when a call carries no attribution', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink, attribution: { feature: 'chat' } }),
    });

    await generateText({ model, prompt: 'hi' });

    expect(sink.records[0]?.attribution).toEqual({ feature: 'chat' });
  });

  it('rolls metered spend up by tenant end to end', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink, prices: { 'mock/opus': { input: 1_000_000, output: 1_000_000 } } }),
    });

    await generateText({
      model,
      prompt: 'a',
      providerOptions: { abacus: { tenant: 'acme' } },
    });
    await generateText({
      model,
      prompt: 'b',
      providerOptions: { abacus: { tenant: 'globex' } },
    });

    const byTenant = sink.rollup('tenant');
    expect(byTenant.map((e) => e.key)).toEqual(['acme', 'globex']);
    expect(byTenant.every((e) => e.count === 1)).toBe(true);
  });
});
