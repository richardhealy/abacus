import type { MeterRecord, MeterSink, TokenUsage } from './types.js';

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
}

/**
 * A {@link MeterSink} that buffers records in memory. Useful for tests, the
 * offline example, and local development. Production deployments swap in a
 * durable sink (Redis / OpenTelemetry) without changing the middleware.
 */
export class InMemoryMeterSink implements MeterSink {
  private readonly buffer: MeterRecord[] = [];

  record(record: MeterRecord): void {
    this.buffer.push(record);
  }

  /** All records captured so far, in the order they were metered. */
  get records(): readonly MeterRecord[] {
    return this.buffer;
  }

  /** Number of metered calls captured. */
  get count(): number {
    return this.buffer.length;
  }

  /** Summed token usage across every captured record. */
  totals(): TokenUsage {
    return this.buffer.reduce<TokenUsage>((acc, { usage }) => {
      acc.inputTokens += usage.inputTokens;
      acc.outputTokens += usage.outputTokens;
      acc.totalTokens += usage.totalTokens;
      acc.cachedInputTokens += usage.cachedInputTokens;
      acc.reasoningTokens += usage.reasoningTokens;
      return acc;
    }, emptyUsage());
  }

  /** Discard all captured records. */
  clear(): void {
    this.buffer.length = 0;
  }
}
