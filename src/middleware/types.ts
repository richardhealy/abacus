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
