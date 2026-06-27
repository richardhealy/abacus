/**
 * The core metering vocabulary every other module speaks: {@link TokenUsage}
 * (normalized, flat token counts), {@link MeterRecord} (one metered call), and
 * the {@link MeterSink} seam records are written to. Deliberately dependency-free
 * data shapes, so attribution, pricing, budgets, and observability all build on
 * them without a dependency cycle.
 *
 * @module
 */
import type { Attribution } from '../attribution/types.js';

/**
 * Normalized, flattened token usage for a single model call.
 *
 * The AI SDK's `LanguageModelV3Usage` is a nested shape whose every field can
 * be `undefined`. abacus normalizes it once, at the metering boundary, into
 * flat counts that are trivial to sum, store, and (later) price. Every field
 * defaults to `0` when the provider does not report it, so downstream cost math
 * never has to guard for `undefined`.
 */
export interface TokenUsage {
  /** Total input (prompt) tokens, including any cached tokens. */
  inputTokens: number;
  /** Total output (completion) tokens, including reasoning tokens. */
  outputTokens: number;
  /** Sum of input and output tokens. */
  totalTokens: number;
  /** Input tokens served from the provider's prompt cache (read). */
  cachedInputTokens: number;
  /** Output tokens spent on model reasoning. */
  reasoningTokens: number;
}

/**
 * One metered model call: which model ran, when, how long it took, and how many
 * tokens it consumed. This is the atomic unit the rest of abacus attributes,
 * prices, and rolls up.
 */
export interface MeterRecord {
  /** Provider-reported model id, e.g. `"anthropic/claude-opus-4"`. */
  modelId: string;
  /** Provider name, e.g. `"gateway"` or `"anthropic"`. */
  provider: string;
  /** Epoch milliseconds at which the underlying call completed. */
  timestamp: number;
  /** Wall-clock duration of the underlying model call, in milliseconds. */
  latencyMs: number;
  /** Normalized token usage for the call. */
  usage: TokenUsage;
  /**
   * Who/what the call is attributed to (tenant / feature / user). Present when
   * the call carried attribution — via per-call `providerOptions.abacus` or the
   * middleware's static default — and `undefined` otherwise, so an
   * unattributed call is distinguishable from one tagged with empty values.
   */
  attribution?: Attribution;
  /**
   * Computed cost of the call in US dollars, present only when the metering
   * middleware was given a price table and the model was found in it. Left
   * `undefined` when no prices are configured or the model is unpriced, so
   * downstream code can tell "free" apart from "not yet priced".
   */
  cost?: number;
}

/**
 * A destination for metered records. Implementations might buffer in memory,
 * push to Redis, or emit OpenTelemetry spans via watchtower.
 *
 * `record` may be synchronous or async. The metering middleware awaits it and
 * isolates any failure, so a slow or throwing sink can never break the wrapped
 * model call — see {@link MeteringOptions.onError}.
 */
export interface MeterSink {
  record(record: MeterRecord): void | Promise<void>;
}
