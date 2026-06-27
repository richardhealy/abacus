import type { LanguageModelV3Middleware } from '@ai-sdk/provider';
import { priceFor, costOf } from '../pricing/cost.js';
import type { PriceTable } from '../pricing/types.js';
import type { MeterRecord, MeterSink } from './types.js';
import { normalizeUsage } from './usage.js';

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
 * AI SDK middleware that meters every `generate` call: it times the underlying
 * model call and records normalized token usage to the configured
 * {@link MeterSink}. Attach it with one line via `wrapLanguageModel` and the
 * caller never has to know.
 *
 * ```ts
 * const model = wrapLanguageModel({
 *   model: gateway('anthropic/claude-opus-4'),
 *   middleware: meteringMiddleware({ sink }),
 * });
 * ```
 *
 * Recording happens after the model returns, so metering adds no latency to the
 * critical path beyond the sink write itself, and never alters the result.
 *
 * Streaming (`wrapStream`) metering arrives in the metering milestone; for now
 * this middleware meters the `generateText` / `generateObject` path.
 */
export function meteringMiddleware(
  options: MeteringOptions,
): LanguageModelV3Middleware {
  const now = options.now ?? Date.now;
  const onError = options.onError ?? defaultOnError;
  const onUnpricedModel = options.onUnpricedModel ?? defaultOnUnpricedModel;
  const prices = options.prices;
  const warnedModels = new Set<string>();

  return {
    specificationVersion: 'v3',

    wrapGenerate: async ({ doGenerate, model }) => {
      const startedAt = now();
      const result = await doGenerate();
      const completedAt = now();

      const usage = normalizeUsage(result.usage);
      const record: MeterRecord = {
        modelId: model.modelId,
        provider: model.provider,
        timestamp: completedAt,
        latencyMs: completedAt - startedAt,
        usage,
      };

      if (prices !== undefined) {
        const price = priceFor(model.modelId, prices);
        if (price !== undefined) {
          record.cost = costOf(usage, price).totalCost;
        } else if (!warnedModels.has(model.modelId)) {
          warnedModels.add(model.modelId);
          onUnpricedModel(model.modelId);
        }
      }

      try {
        await options.sink.record(record);
      } catch (error) {
        onError(error, record);
      }

      return result;
    },
  };
}
