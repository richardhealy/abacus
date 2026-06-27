import {
  rollupByDimension,
  type RollupEntry,
  type RollupOptions,
} from '../attribution/rollup.js';
import type { AttributionDimension } from '../attribution/types.js';
import type { MeterRecord, MeterSink, TokenUsage } from './types.js';
import { zeroUsage } from './usage.js';

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
    }, zeroUsage());
  }

  /**
   * Total cost, in USD, summed across every captured record that carries one.
   * Records metered without a price table contribute `0`. Returned to
   * nano-dollar precision, matching how each per-call cost is rounded.
   */
  totalCost(): number {
    const NANO = 1e9;
    const sum = this.buffer.reduce((acc, { cost }) => acc + (cost ?? 0), 0);
    return Math.round(sum * NANO) / NANO;
  }

  /**
   * Spend and usage grouped by an attribution dimension (tenant / feature /
   * user), sorted by cost descending. This is the spend-by-dimension view the
   * spec asks `/usage` to expose; here it lets a test assert that a tagged call
   * shows up under the right tenant or feature.
   */
  rollup(
    dimension: AttributionDimension,
    options?: RollupOptions,
  ): RollupEntry[] {
    return rollupByDimension(this.buffer, dimension, options);
  }

  /** Discard all captured records. */
  clear(): void {
    this.buffer.length = 0;
  }
}
