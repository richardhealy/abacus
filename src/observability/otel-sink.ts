import type { MeterRecord, MeterSink } from '../middleware/types.js';
import {
  attributionAttributes,
  genAiMetricAttributes,
  genAiSpanAttributes,
  spanName,
  ATTR_GEN_AI_TOKEN_TYPE,
  DEFAULT_OPERATION_NAME,
  METRIC_ABACUS_COST_USD,
  METRIC_GEN_AI_OPERATION_DURATION,
  METRIC_GEN_AI_TOKEN_USAGE,
  TOKEN_TYPE_INPUT,
  TOKEN_TYPE_OUTPUT,
  type OTelAttributes,
} from './gen-ai.js';

/**
 * A point in time as OpenTelemetry accepts it. abacus passes epoch milliseconds
 * (what {@link MeterRecord.timestamp} already is); a `Date` is accepted too.
 */
export type OTelTimeInput = number | Date;

/** `SpanKind.CLIENT` — a GenAI call is an outbound request to the model provider. */
export const SPAN_KIND_CLIENT = 2;

/**
 * The slice of an OpenTelemetry `Span` abacus uses. Attributes and the start
 * time are supplied up front to {@link OTelTracerLike.startSpan}, so all that is
 * left is to close the span at the call's end time — hence `end` is the only
 * method on the seam. A real OTel `Span` satisfies this structurally.
 */
export interface OTelSpanLike {
  end(endTime?: OTelTimeInput): void;
}

/** Options for {@link OTelTracerLike.startSpan}; a structural subset of OTel's `SpanOptions`. */
export interface OTelSpanOptions {
  /** Span kind; abacus passes {@link SPAN_KIND_CLIENT}. */
  kind?: number;
  /** When the call started — abacus back-dates this to `timestamp - latencyMs`. */
  startTime?: OTelTimeInput;
  /** Attributes to attach at creation. */
  attributes?: OTelAttributes;
}

/**
 * The slice of an OpenTelemetry `Tracer` abacus uses: starting a span. A real
 * OTel `Tracer` satisfies this (its `startSpan` takes an extra optional
 * `context` argument, which structural typing tolerates).
 */
export interface OTelTracerLike {
  startSpan(name: string, options?: OTelSpanOptions): OTelSpanLike;
}

/** Options when creating an instrument; a structural subset of OTel's `MetricOptions`. */
export interface OTelInstrumentOptions {
  unit?: string;
  description?: string;
}

/** The slice of an OpenTelemetry `Histogram` abacus uses. */
export interface OTelHistogramLike {
  record(value: number, attributes?: OTelAttributes): void;
}

/** The slice of an OpenTelemetry `Counter` abacus uses. */
export interface OTelCounterLike {
  add(value: number, attributes?: OTelAttributes): void;
}

/**
 * The slice of an OpenTelemetry `Meter` abacus uses: creating the histograms and
 * counter it records to. A real OTel `Meter` satisfies this structurally.
 */
export interface OTelMeterLike {
  createHistogram(
    name: string,
    options?: OTelInstrumentOptions,
  ): OTelHistogramLike;
  createCounter(name: string, options?: OTelInstrumentOptions): OTelCounterLike;
}

export interface OTelMeterSinkOptions {
  /**
   * Tracer to emit GenAI spans to. Provide a tracer, a meter, or both — at least
   * one is required. With a tracer, each metered call becomes one `gen_ai.*`
   * span back-dated to span the real call duration.
   */
  tracer?: OTelTracerLike;
  /**
   * Meter to record GenAI metrics to. With a meter, each call records the
   * `gen_ai.client.token.usage` and `gen_ai.client.operation.duration`
   * histograms, plus an `abacus.cost.usd` counter when the call is priced.
   */
  meter?: OTelMeterLike;
  /**
   * The `gen_ai.operation.name` to tag spans and metrics with. A
   * {@link MeterRecord} does not record the call kind, so this defaults to
   * {@link DEFAULT_OPERATION_NAME} (`"chat"`); set it if a wrapped model serves
   * a different operation (e.g. `"embeddings"`).
   */
  operationName?: string;
}

/**
 * A {@link MeterSink} that emits each metered call as OpenTelemetry GenAI
 * telemetry — the observability half of abacus's "enforce here, observe through
 * watchtower" split. abacus does not build its own tracing: this sink writes to
 * a tracer and/or meter you supply (watchtower's, in production), so spend shows
 * up as standard `gen_ai.*` spans and metrics alongside every other LLM call.
 *
 * It is written against the small {@link OTelTracerLike} / {@link OTelMeterLike}
 * seams rather than `@opentelemetry/api`, so abacus keeps no runtime OTel
 * dependency — the real OTel `Tracer` and `Meter` satisfy these structurally and
 * drop straight in:
 *
 * ```ts
 * import { trace, metrics } from '@opentelemetry/api';
 * const sink = otelMeterSink({
 *   tracer: trace.getTracer('abacus'),
 *   meter: metrics.getMeter('abacus'),
 * });
 * const model = wrapLanguageModel({
 *   model: gateway('anthropic/claude-opus-4'),
 *   middleware: meteringMiddleware({ sink, prices: defaultPrices }),
 * });
 * ```
 *
 * Spans are created already completed: the call has returned by the time the
 * sink runs, so the span is started at `timestamp - latencyMs` and ended at
 * `timestamp`, reproducing the real call window without holding a span open
 * across the call. Metric instruments are created once, when the sink is built.
 *
 * Like every sink, this is invoked by the metering middleware inside a
 * try/catch, so a tracer or meter that throws routes to the middleware's
 * `onError` and never breaks the wrapped model call.
 */
export function otelMeterSink(options: OTelMeterSinkOptions): MeterSink {
  const { tracer, meter } = options;
  if (tracer === undefined && meter === undefined) {
    throw new TypeError('otelMeterSink requires a tracer, a meter, or both');
  }
  const operationName = options.operationName ?? DEFAULT_OPERATION_NAME;

  // Instruments are created once and reused for every record. The non-null
  // assertions below are guarded by these being defined iff `meter` is.
  const tokenUsage = meter?.createHistogram(METRIC_GEN_AI_TOKEN_USAGE, {
    unit: '{token}',
    description: 'Number of tokens used in a GenAI call, by token type',
  });
  const operationDuration = meter?.createHistogram(
    METRIC_GEN_AI_OPERATION_DURATION,
    { unit: 's', description: 'Duration of a GenAI call' },
  );
  const costCounter = meter?.createCounter(METRIC_ABACUS_COST_USD, {
    unit: 'USD',
    description: 'Computed cost of GenAI calls, attributed by tenant/feature/user',
  });

  function emitSpan(record: MeterRecord): void {
    const span = tracer!.startSpan(spanName(operationName, record.modelId), {
      kind: SPAN_KIND_CLIENT,
      startTime: record.timestamp - record.latencyMs,
      attributes: genAiSpanAttributes(record, operationName),
    });
    span.end(record.timestamp);
  }

  function emitMetrics(record: MeterRecord): void {
    const base = genAiMetricAttributes(record, operationName);
    // Token usage is one histogram split into input/output series by token type,
    // per the GenAI metric semantics.
    tokenUsage!.record(record.usage.inputTokens, {
      ...base,
      [ATTR_GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_INPUT,
    });
    tokenUsage!.record(record.usage.outputTokens, {
      ...base,
      [ATTR_GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_OUTPUT,
    });
    // Duration is in seconds per semconv; the record carries milliseconds.
    operationDuration!.record(record.latencyMs / 1000, base);
    // Cost carries attribution so the counter aggregates spend by tenant/feature
    // /user. Skipped entirely for an unpriced call, so the spend total is not
    // diluted by zeros that merely mean "not yet priced".
    if (record.cost !== undefined) {
      costCounter!.add(record.cost, {
        ...base,
        ...attributionAttributes(record.attribution),
      });
    }
  }

  return {
    record(record: MeterRecord): void {
      if (tracer !== undefined) emitSpan(record);
      if (meter !== undefined) emitMetrics(record);
    },
  };
}
