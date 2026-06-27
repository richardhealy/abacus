import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import {
  attributionFromProviderOptions,
  mergeAttribution,
} from '../attribution/provider-options.js';
import type { Attribution } from '../attribution/types.js';
import { priceFor, costOf } from '../pricing/cost.js';
import type { PriceTable } from '../pricing/types.js';
import type { MeterRecord, MeterSink, TokenUsage } from './types.js';
import { normalizeUsage, zeroUsage } from './usage.js';

export interface MeteringOptions {
  /** Where metered records are sent. */
  sink: MeterSink;
  /**
   * Optional price table. When provided, each record carries a `cost` (USD)
   * computed from the call's token usage. Omit it and records are metered
   * without cost — metering does not require pricing to function.
   */
  prices?: PriceTable;
  /**
   * Static attribution applied to every metered call — useful when one wrapped
   * model serves a single feature, e.g. `{ feature: 'chat' }`. Per-call
   * attribution passed via `providerOptions.abacus` is merged on top of this,
   * with the per-call values winning field by field. Omit it and calls are
   * attributed solely from their `providerOptions`.
   */
  attribution?: Attribution;
  /**
   * Clock used for timing and timestamps. Defaults to `Date.now`. Injectable so
   * tests can assert exact latencies deterministically.
   */
  now?: () => number;
  /**
   * Invoked if the sink throws while recording a call. The wrapped model call
   * always succeeds regardless — metering is a cross-cutting concern and must
   * never break or fail the business call it observes. Defaults to logging the
   * error (loud, but non-fatal) rather than swallowing it silently.
   */
  onError?: (error: unknown, record: MeterRecord) => void;
  /**
   * Invoked the first time a model is metered against a configured price table
   * but has no matching entry. The record is still produced (with no `cost`);
   * this hook surfaces the gap rather than letting unpriced spend pass
   * silently. Fired at most once per distinct model id. Defaults to a single
   * `console.warn`. Only relevant when {@link MeteringOptions.prices} is set.
   */
  onUnpricedModel?: (modelId: string) => void;
}

function defaultOnError(error: unknown, record: MeterRecord): void {
  console.error(
    `[abacus] failed to record metered call for "${record.modelId}":`,
    error,
  );
}

function defaultOnUnpricedModel(modelId: string): void {
  console.warn(
    `[abacus] no price configured for model "${modelId}"; recording without cost`,
  );
}

/**
 * AI SDK middleware that meters every model call — both the buffered
 * (`generateText` / `generateObject`) and the streaming (`streamText` /
 * `streamObject`) path: it times the underlying call and records normalized
 * token usage to the configured {@link MeterSink}. Attach it with one line via
 * `wrapLanguageModel` and the caller never has to know.
 *
 * ```ts
 * const model = wrapLanguageModel({
 *   model: gateway('anthropic/claude-opus-4'),
 *   middleware: meteringMiddleware({ sink }),
 * });
 * ```
 *
 * On the buffered path, recording happens after the model returns. On the
 * streaming path the parts flow through untouched and the record is written
 * when the stream completes, reading usage from the terminal `finish` part — so
 * metering adds no latency to the critical path beyond the sink write itself,
 * and never alters the result or the stream.
 */
export function meteringMiddleware(
  options: MeteringOptions,
): LanguageModelV3Middleware {
  const now = options.now ?? Date.now;
  const onError = options.onError ?? defaultOnError;
  const onUnpricedModel = options.onUnpricedModel ?? defaultOnUnpricedModel;
  const prices = options.prices;
  const defaultAttribution = options.attribution;
  const warnedModels = new Set<string>();

  /**
   * Assemble a {@link MeterRecord} from a completed call's usage and timing,
   * applying attribution and (when configured) cost. Shared by the buffered and
   * streaming paths so both produce identical records.
   */
  function buildRecord(
    model: LanguageModelV3,
    params: LanguageModelV3CallOptions,
    usage: TokenUsage,
    startedAt: number,
    completedAt: number,
  ): MeterRecord {
    const attribution = mergeAttribution(
      defaultAttribution,
      attributionFromProviderOptions(params.providerOptions),
    );
    const record: MeterRecord = {
      modelId: model.modelId,
      provider: model.provider,
      timestamp: completedAt,
      latencyMs: completedAt - startedAt,
      usage,
    };
    if (attribution !== undefined) {
      record.attribution = attribution;
    }

    if (prices !== undefined) {
      const price = priceFor(model.modelId, prices);
      if (price !== undefined) {
        record.cost = costOf(usage, price).totalCost;
      } else if (!warnedModels.has(model.modelId)) {
        warnedModels.add(model.modelId);
        onUnpricedModel(model.modelId);
      }
    }

    return record;
  }

  /**
   * Write a record to the sink, isolating any failure through `onError`.
   * Metering is a cross-cutting concern and must never break the call it
   * observes — including the streaming path, where a throwing sink would
   * otherwise surface as a stream error to the caller.
   */
  async function emit(record: MeterRecord): Promise<void> {
    try {
      await options.sink.record(record);
    } catch (error) {
      onError(error, record);
    }
  }

  return {
    specificationVersion: 'v3',

    wrapGenerate: async ({ doGenerate, model, params }) => {
      const startedAt = now();
      const result = await doGenerate();
      const completedAt = now();

      await emit(
        buildRecord(
          model,
          params,
          normalizeUsage(result.usage),
          startedAt,
          completedAt,
        ),
      );

      return result;
    },

    wrapStream: async ({ doStream, model, params }) => {
      const startedAt = now();
      const { stream, ...rest } = await doStream();

      // Usage arrives on the terminal `finish` part. Capture it as the parts
      // flow past, then record once the stream drains (flush). The parts are
      // forwarded untouched, so the caller sees an identical stream.
      let usage: LanguageModelV3Usage | undefined;
      const meter = new TransformStream<
        LanguageModelV3StreamPart,
        LanguageModelV3StreamPart
      >({
        transform(part, controller) {
          if (part.type === 'finish') {
            usage = part.usage;
          }
          controller.enqueue(part);
        },
        flush: async () => {
          const completedAt = now();
          const normalized =
            usage === undefined ? zeroUsage() : normalizeUsage(usage);
          await emit(
            buildRecord(model, params, normalized, startedAt, completedAt),
          );
        },
      });

      return { ...rest, stream: stream.pipeThrough(meter) };
    },
  };
}
