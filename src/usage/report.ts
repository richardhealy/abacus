/**
 * {@link buildUsageReport} (M5): the pure core of the `/usage` view. It windows
 * records to `[since, until)` and rolls them up by each requested dimension via
 * the shared {@link rollupByDimension}, returning a {@link UsageReport} of totals
 * plus per-dimension spend. Pure and HTTP-free, so the JSON endpoint, the
 * dashboard, and an offline snapshot all compute spend the same way.
 *
 * @module
 */
import { rollupByDimension, type RollupEntry } from '../attribution/rollup.js';
import {
  ATTRIBUTION_DIMENSIONS,
  type AttributionDimension,
} from '../attribution/types.js';
import type { MeterRecord, TokenUsage } from '../middleware/types.js';
import { zeroUsage } from '../middleware/usage.js';

const NANO = 1e9;

/** The time window a report covers; `null` on a bound means unbounded. */
export interface UsageWindow {
  /** Inclusive lower bound on `record.timestamp` (epoch ms), or `null`. */
  since: number | null;
  /** Exclusive upper bound on `record.timestamp` (epoch ms), or `null`. */
  until: number | null;
}

/** Grand totals across every record a report covers. */
export interface UsageTotals {
  /** Number of metered calls in the window. */
  count: number;
  /** Summed token usage across those calls. */
  usage: TokenUsage;
  /** Summed cost in USD (unpriced calls contribute `0`), nano-dollar rounded. */
  cost: number;
}

/**
 * A spend-by-dimension snapshot: the totals plus a cost-sorted rollup for each
 * requested attribution dimension. This is the JSON shape the `/usage` endpoint
 * returns and the dashboard (M6) renders.
 */
export interface UsageReport {
  /** The window the report was computed over (echoes the request bounds). */
  window: UsageWindow;
  /** Grand totals across the window. */
  totals: UsageTotals;
  /**
   * Spend and usage grouped by each requested dimension, each list sorted by
   * cost descending. Only the dimensions asked for are present.
   */
  byDimension: Partial<Record<AttributionDimension, RollupEntry[]>>;
}

/** Options for {@link buildUsageReport}. */
export interface UsageReportOptions {
  /**
   * Which attribution dimensions to roll up by. Defaults to all of
   * tenant / feature / user.
   */
  dimensions?: readonly AttributionDimension[];
  /** Inclusive lower bound on `record.timestamp` (epoch ms). */
  since?: number;
  /** Exclusive upper bound on `record.timestamp` (epoch ms). */
  until?: number;
  /** Group key for records missing a dimension; see {@link rollupByDimension}. */
  unattributedKey?: string;
}

function totalsOf(records: readonly MeterRecord[]): UsageTotals {
  const usage = zeroUsage();
  let cost = 0;
  for (const record of records) {
    usage.inputTokens += record.usage.inputTokens;
    usage.outputTokens += record.usage.outputTokens;
    usage.totalTokens += record.usage.totalTokens;
    usage.cachedInputTokens += record.usage.cachedInputTokens;
    usage.reasoningTokens += record.usage.reasoningTokens;
    cost += record.cost ?? 0;
  }
  return { count: records.length, usage, cost: Math.round(cost * NANO) / NANO };
}

/**
 * Build the spend-by-dimension {@link UsageReport} the `/usage` endpoint serves.
 *
 * Pure and deterministic — the same records and options always yield the same
 * report. Records are first filtered to the `[since, until)` window (each bound
 * optional), then rolled up by each requested dimension via the shared
 * {@link rollupByDimension}, so the endpoint and the in-memory sink compute spend
 * the same way. `since` is inclusive and `until` is exclusive, so adjacent
 * windows partition records without double-counting.
 */
export function buildUsageReport(
  records: readonly MeterRecord[],
  options: UsageReportOptions = {},
): UsageReport {
  const since = options.since ?? null;
  const until = options.until ?? null;
  const dimensions = options.dimensions ?? ATTRIBUTION_DIMENSIONS;

  const filtered = records.filter(
    (record) =>
      (since === null || record.timestamp >= since) &&
      (until === null || record.timestamp < until),
  );

  const rollupOptions =
    options.unattributedKey === undefined
      ? undefined
      : { unattributedKey: options.unattributedKey };

  const byDimension: Partial<Record<AttributionDimension, RollupEntry[]>> = {};
  for (const dimension of dimensions) {
    byDimension[dimension] = rollupByDimension(filtered, dimension, rollupOptions);
  }

  return { window: { since, until }, totals: totalsOf(filtered), byDimension };
}
