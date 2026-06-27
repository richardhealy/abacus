/**
 * Rolling metered records up by attribution dimension. {@link rollupByDimension}
 * groups records by a tenant / feature / user value and sums their usage and
 * cost, sorted by cost so the priciest leads — the spend-by-dimension view the
 * in-memory sink, the `/usage` endpoint, and the dashboard all share. Pure, so
 * every surface computes spend identically.
 *
 * @module
 */
import type { MeterRecord, TokenUsage } from '../middleware/types.js';
import type { AttributionDimension } from './types.js';

/** Default group key for records that carry no value on the rolled-up dimension. */
export const UNATTRIBUTED_KEY = '(unattributed)';

const NANO = 1e9;

/** Spend and usage rolled up for one value of an attribution dimension. */
export interface RollupEntry {
  /** The dimension value, e.g. a tenant id, or {@link UNATTRIBUTED_KEY}. */
  key: string;
  /** Number of metered calls attributed to this key. */
  count: number;
  /** Summed token usage across those calls. */
  usage: TokenUsage;
  /**
   * Summed cost in USD across those calls. Records metered without a price
   * contribute `0`; rounded to nano-dollar precision, matching per-call cost.
   */
  cost: number;
}

/** Options for {@link rollupByDimension}. */
export interface RollupOptions {
  /** Group key for records missing the dimension. Defaults to {@link UNATTRIBUTED_KEY}. */
  unattributedKey?: string;
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
}

function addUsage(into: TokenUsage, from: TokenUsage): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.totalTokens += from.totalTokens;
  into.cachedInputTokens += from.cachedInputTokens;
  into.reasoningTokens += from.reasoningTokens;
}

/**
 * Group metered records by one attribution dimension and sum their usage and
 * cost. This is the spend-by-tenant / spend-by-feature view the `/usage`
 * endpoint (M5) and the in-memory sink both surface.
 *
 * Records with no value on the dimension are collected under
 * {@link RollupOptions.unattributedKey} rather than dropped, so a rollup always
 * accounts for every record. Entries come back sorted by cost descending (then
 * key ascending) so the priciest dimension value leads and the order is
 * deterministic.
 */
export function rollupByDimension(
  records: readonly MeterRecord[],
  dimension: AttributionDimension,
  options: RollupOptions = {},
): RollupEntry[] {
  const unattributedKey = options.unattributedKey ?? UNATTRIBUTED_KEY;
  const byKey = new Map<string, RollupEntry>();

  for (const record of records) {
    const key = record.attribution?.[dimension] ?? unattributedKey;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { key, count: 0, usage: emptyUsage(), cost: 0 };
      byKey.set(key, entry);
    }
    entry.count += 1;
    addUsage(entry.usage, record.usage);
    entry.cost += record.cost ?? 0;
  }

  const entries = [...byKey.values()];
  for (const entry of entries) {
    entry.cost = Math.round(entry.cost * NANO) / NANO;
  }
  entries.sort((a, b) => b.cost - a.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries;
}
