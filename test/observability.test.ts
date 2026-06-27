import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { generateText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type {
  MeterRecord,
  OTelAttributes,
  OTelCounterLike,
  OTelHistogramLike,
  OTelInstrumentOptions,
  OTelMeterLike,
  OTelSpanLike,
  OTelSpanOptions,
  OTelTimeInput,
  OTelTracerLike,
} from '../src/index.js';
import {
  attributionAttributes,
  genAiMetricAttributes,
  genAiSpanAttributes,
  meteringMiddleware,
  otelMeterSink,
  spanName,
  SPAN_KIND_CLIENT,
  METRIC_ABACUS_COST_USD,
  METRIC_GEN_AI_OPERATION_DURATION,
  METRIC_GEN_AI_TOKEN_USAGE,
} from '../src/index.js';

function record(overrides: Partial<MeterRecord> = {}): MeterRecord {
  return {
    modelId: 'anthropic/claude-opus-4',
    provider: 'anthropic',
    timestamp: 1_000,
    latencyMs: 250,
    usage: {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cachedInputTokens: 20,
      reasoningTokens: 5,
    },
    ...overrides,
  };
}

// ---- Fakes capturing what abacus emits to a tracer / meter. ----

interface StartedSpan {
  name: string;
  options: OTelSpanOptions | undefined;
  endTime?: OTelTimeInput | undefined;
  ended: boolean;
}

class FakeTracer implements OTelTracerLike {
  readonly spans: StartedSpan[] = [];

  startSpan(name: string, options?: OTelSpanOptions): OTelSpanLike {
    const span: StartedSpan = { name, options, ended: false };
    this.spans.push(span);
    return {
      end(endTime?: OTelTimeInput): void {
        span.ended = true;
        span.endTime = endTime;
      },
    };
  }
}

interface MetricPoint {
  value: number;
  attributes: OTelAttributes | undefined;
}

class FakeInstrument implements OTelHistogramLike, OTelCounterLike {
  readonly name: string;
  readonly options: OTelInstrumentOptions | undefined;
  readonly points: MetricPoint[] = [];

  constructor(name: string, options?: OTelInstrumentOptions) {
    this.name = name;
    this.options = options;
  }

  record(value: number, attributes?: OTelAttributes): void {
    this.points.push({ value, attributes });
  }

  add(value: number, attributes?: OTelAttributes): void {
    this.points.push({ value, attributes });
  }
}

class FakeMeter implements OTelMeterLike {
  readonly instruments = new Map<string, FakeInstrument>();

  private make(name: string, options?: OTelInstrumentOptions): FakeInstrument {
    const instrument = new FakeInstrument(name, options);
    this.instruments.set(name, instrument);
    return instrument;
  }

  createHistogram(name: string, options?: OTelInstrumentOptions): FakeInstrument {
    return this.make(name, options);
  }

  createCounter(name: string, options?: OTelInstrumentOptions): FakeInstrument {
    return this.make(name, options);
  }

  get(name: string): FakeInstrument {
    const instrument = this.instruments.get(name);
    if (instrument === undefined) throw new Error(`no instrument ${name}`);
    return instrument;
  }
}

describe('gen_ai attribute mapping', () => {
  it('builds the span name as "{operation} {model}"', () => {
    expect(spanName('chat', 'anthropic/claude-opus-4')).toBe(
      'chat anthropic/claude-opus-4',
    );
  });

  it('maps the low-cardinality metric attributes', () => {
    expect(genAiMetricAttributes(record())).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'anthropic/claude-opus-4',
      'gen_ai.response.model': 'anthropic/claude-opus-4',
    });
  });

  it('honors a custom operation name', () => {
    expect(genAiMetricAttributes(record(), 'embeddings')['gen_ai.operation.name']).toBe(
      'embeddings',
    );
  });

  it('maps full span attributes including usage, cost, and attribution', () => {
    const attrs = genAiSpanAttributes(
      record({
        cost: 0.0123,
        attribution: { tenant: 'acme', feature: 'chat', tags: { env: 'prod' } },
      }),
    );
    expect(attrs).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'anthropic/claude-opus-4',
      'gen_ai.response.model': 'anthropic/claude-opus-4',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 40,
      'abacus.usage.total_tokens': 140,
      'abacus.usage.cached_input_tokens': 20,
      'abacus.usage.reasoning_tokens': 5,
      'abacus.cost.usd': 0.0123,
      'abacus.tenant': 'acme',
      'abacus.feature': 'chat',
      'abacus.tag.env': 'prod',
    });
  });

  it('omits cost when the record carries none', () => {
    expect(genAiSpanAttributes(record())).not.toHaveProperty('abacus.cost.usd');
  });

  it('omits absent attribution fields rather than setting undefined', () => {
    expect(attributionAttributes(undefined)).toEqual({});
    expect(attributionAttributes({ tenant: 'acme' })).toEqual({ 'abacus.tenant': 'acme' });
  });
});

describe('otelMeterSink', () => {
  it('requires a tracer or a meter', () => {
    expect(() => otelMeterSink({})).toThrow(TypeError);
  });

  it('emits one back-dated gen_ai span per call', () => {
    const tracer = new FakeTracer();
    const sink = otelMeterSink({ tracer });

    sink.record(record({ cost: 0.5, attribution: { tenant: 'acme' } }));

    expect(tracer.spans).toHaveLength(1);
    const span = tracer.spans[0]!;
    expect(span.name).toBe('chat anthropic/claude-opus-4');
    expect(span.ended).toBe(true);
    expect(span.options?.kind).toBe(SPAN_KIND_CLIENT);
    // Back-dated to span the real call window: [timestamp - latencyMs, timestamp].
    expect(span.options?.startTime).toBe(750);
    expect(span.endTime).toBe(1_000);
    expect(span.options?.attributes).toEqual(
      genAiSpanAttributes(record({ cost: 0.5, attribution: { tenant: 'acme' } })),
    );
  });

  it('records token, duration, and cost metrics with the right units', () => {
    const meter = new FakeMeter();
    const sink = otelMeterSink({ meter });

    sink.record(record({ cost: 0.5, attribution: { tenant: 'acme', feature: 'chat' } }));

    const tokens = meter.get(METRIC_GEN_AI_TOKEN_USAGE);
    expect(tokens.options?.unit).toBe('{token}');
    expect(tokens.points).toEqual([
      {
        value: 100,
        attributes: { ...genAiMetricAttributes(record()), 'gen_ai.token.type': 'input' },
      },
      {
        value: 40,
        attributes: { ...genAiMetricAttributes(record()), 'gen_ai.token.type': 'output' },
      },
    ]);

    const duration = meter.get(METRIC_GEN_AI_OPERATION_DURATION);
    expect(duration.options?.unit).toBe('s');
    // 250ms recorded as seconds.
    expect(duration.points).toEqual([{ value: 0.25, attributes: genAiMetricAttributes(record()) }]);

    const cost = meter.get(METRIC_ABACUS_COST_USD);
    expect(cost.points).toEqual([
      {
        value: 0.5,
        attributes: {
          ...genAiMetricAttributes(record()),
          'abacus.tenant': 'acme',
          'abacus.feature': 'chat',
        },
      },
    ]);
  });

  it('skips the cost counter for an unpriced call', () => {
    const meter = new FakeMeter();
    const sink = otelMeterSink({ meter });

    sink.record(record()); // no cost

    expect(meter.get(METRIC_ABACUS_COST_USD).points).toEqual([]);
    // Token + duration metrics still recorded.
    expect(meter.get(METRIC_GEN_AI_TOKEN_USAGE).points).toHaveLength(2);
    expect(meter.get(METRIC_GEN_AI_OPERATION_DURATION).points).toHaveLength(1);
  });

  it('emits both spans and metrics when given both', () => {
    const tracer = new FakeTracer();
    const meter = new FakeMeter();
    const sink = otelMeterSink({ tracer, meter });

    sink.record(record({ cost: 1 }));

    expect(tracer.spans).toHaveLength(1);
    expect(meter.get(METRIC_GEN_AI_TOKEN_USAGE).points).toHaveLength(2);
    expect(meter.get(METRIC_ABACUS_COST_USD).points).toHaveLength(1);
  });

  it('tags spans and metrics with a custom operation name', () => {
    const tracer = new FakeTracer();
    const meter = new FakeMeter();
    const sink = otelMeterSink({ tracer, meter, operationName: 'embeddings' });

    sink.record(record());

    expect(tracer.spans[0]!.name).toBe('embeddings anthropic/claude-opus-4');
    expect(meter.get(METRIC_GEN_AI_OPERATION_DURATION).points[0]!.attributes).toMatchObject({
      'gen_ai.operation.name': 'embeddings',
    });
  });
});

describe('otelMeterSink wired through meteringMiddleware', () => {
  const usage: LanguageModelV3Usage = {
    inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 8, text: 8, reasoning: 0 },
  };

  function mockModel(): LanguageModelV3 {
    return new MockLanguageModelV3({
      provider: 'anthropic',
      modelId: 'anthropic/claude-opus-4',
      doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      }),
    });
  }

  it('emits a gen_ai span for a wrapped, attributed call', async () => {
    const tracer = new FakeTracer();
    const model = wrapLanguageModel({
      model: mockModel(),
      middleware: meteringMiddleware({ sink: otelMeterSink({ tracer }) }),
    });

    const { text } = await generateText({
      model,
      prompt: 'hi',
      providerOptions: { abacus: { tenant: 'acme', feature: 'chat' } },
    });

    expect(text).toBe('ok');
    expect(tracer.spans).toHaveLength(1);
    const attrs = tracer.spans[0]!.options?.attributes;
    expect(attrs).toMatchObject({
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'anthropic/claude-opus-4',
      'gen_ai.usage.input_tokens': 42,
      'gen_ai.usage.output_tokens': 8,
      'abacus.tenant': 'acme',
      'abacus.feature': 'chat',
    });
  });
});
