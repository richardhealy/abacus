import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { generateText, streamText, wrapLanguageModel } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import type { MeterRecord, MeterSink } from '../src/index.js';
import { InMemoryMeterSink, meteringMiddleware } from '../src/index.js';

const sampleUsage: LanguageModelV3Usage = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

/** A well-formed stream: a single text chunk and a terminal `finish` carrying usage. */
function textStreamParts(
  text: string,
  usage: LanguageModelV3Usage = sampleUsage,
): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: text },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
}

function streamingModel(
  parts: LanguageModelV3StreamPart[],
  overrides: { provider?: string; modelId?: string } = {},
): LanguageModelV3 {
  return new MockLanguageModelV3({
    provider: overrides.provider ?? 'mock',
    modelId: overrides.modelId ?? 'mock/opus',
    doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
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

/** Drain a `streamText` result, returning the full concatenated text. */
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const delta of stream) text += delta;
  return text;
}

describe('meteringMiddleware streaming', () => {
  it('records token usage, latency, and timestamp once the stream completes', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: streamingModel(textStreamParts('Hello')),
      middleware: meteringMiddleware({ sink, now: fakeClock(1000, 250) }),
    });

    const result = streamText({ model, prompt: 'hi' });
    const text = await drain(result.textStream);

    expect(text).toBe('Hello');
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

  it('forwards the stream unchanged to the caller', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: streamingModel(textStreamParts('Paris.')),
      middleware: meteringMiddleware({ sink }),
    });

    const result = streamText({ model, prompt: 'capital of France?' });

    expect(await drain(result.textStream)).toBe('Paris.');
    expect(await result.usage).toMatchObject({ inputTokens: 42, outputTokens: 8 });
  });

  it('does not record until the stream is consumed', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: streamingModel(textStreamParts('later')),
      middleware: meteringMiddleware({ sink }),
    });

    const result = streamText({ model, prompt: 'hi' });
    // The stream has been requested but not yet drained.
    expect(sink.count).toBe(0);

    await drain(result.textStream);
    expect(sink.count).toBe(1);
  });

  it('prices a streamed call from the price table', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: streamingModel(textStreamParts('hi')),
      middleware: meteringMiddleware({
        sink,
        // 1 USD per 1M tokens → 42 input + 8 output = 50e-6 USD.
        prices: { 'mock/opus': { input: 1, output: 1 } },
      }),
    });

    await drain(streamText({ model, prompt: 'hi' }).textStream);

    expect(sink.records[0]?.cost).toBe(50e-6);
  });

  it('tags a streamed record from per-call providerOptions', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: streamingModel(textStreamParts('hi')),
      middleware: meteringMiddleware({ sink }),
    });

    await drain(
      streamText({
        model,
        prompt: 'hi',
        providerOptions: { abacus: { tenant: 'acme', feature: 'chat', user: 'u_1' } },
      }).textStream,
    );

    expect(sink.records[0]?.attribution).toEqual({
      tenant: 'acme',
      feature: 'chat',
      user: 'u_1',
    });
  });

  it('records zero usage when the stream carries no finish part', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: streamingModel([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: 'partial' },
        { type: 'text-end', id: '0' },
      ]),
      middleware: meteringMiddleware({ sink }),
    });

    await drain(streamText({ model, prompt: 'hi' }).textStream);

    expect(sink.count).toBe(1);
    expect(sink.records[0]?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('never breaks the stream when the sink throws', async () => {
    const onError = vi.fn();
    const boom = new Error('sink down');
    const throwingSink: MeterSink = {
      record() {
        throw boom;
      },
    };
    const model = wrapLanguageModel({
      model: streamingModel(textStreamParts('still here')),
      middleware: meteringMiddleware({ sink: throwingSink, onError }),
    });

    const text = await drain(streamText({ model, prompt: 'hi' }).textStream);

    expect(text).toBe('still here');
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ modelId: 'mock/opus' }),
    );
  });

  it('meters both the buffered and streaming path from one wrapped model', async () => {
    const sink = new InMemoryMeterSink();
    const model = wrapLanguageModel({
      model: new MockLanguageModelV3({
        provider: 'mock',
        modelId: 'mock/opus',
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'buffered' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: sampleUsage,
          warnings: [],
        }),
        doStream: async () => ({
          stream: convertArrayToReadableStream(textStreamParts('streamed')),
        }),
      }),
      middleware: meteringMiddleware({ sink }),
    });

    await generateText({ model, prompt: 'one' });
    await drain(streamText({ model, prompt: 'two' }).textStream);

    expect(sink.count).toBe(2);
    expect(sink.totals().totalTokens).toBe(100);
  });
});
