/**
 * abacus — a cost-governance layer for LLM calls.
 *
 * v1 surface. Metering, attribution, pricing, and budgets are in place; the
 * policy engine and the `/usage` endpoint land in later milestones; see
 * PROGRESS.md.
 */
export { meteringMiddleware } from './middleware/metering.js';
export type { MeteringOptions } from './middleware/metering.js';
export { InMemoryMeterSink } from './middleware/in-memory-sink.js';
export { normalizeUsage } from './middleware/usage.js';
export type { MeterRecord, MeterSink, TokenUsage } from './middleware/types.js';

// Pricing (M2): auditable price table + deterministic cost math.
export { costOf, priceFor, computeCost } from './pricing/cost.js';
export { defaultPrices } from './pricing/prices.js';
export type {
  ModelPrice,
  PriceTable,
  CostBreakdown,
} from './pricing/types.js';

// Attribution (M1): tag spend by tenant / feature / user and roll it up.
export {
  ATTRIBUTION_PROVIDER_KEY,
  attributionFromProviderOptions,
  mergeAttribution,
} from './attribution/provider-options.js';
export {
  rollupByDimension,
  UNATTRIBUTED_KEY,
} from './attribution/rollup.js';
export { ATTRIBUTION_DIMENSIONS } from './attribution/types.js';
export type {
  Attribution,
  AttributionDimension,
} from './attribution/types.js';
export type { RollupEntry, RollupOptions } from './attribution/rollup.js';

// Budgets (M3): Redis-backed soft/hard limits, daily/monthly windows,
// concurrency-safe spend accounting.
export { BUDGET_WINDOWS } from './budget/types.js';
export type {
  Budget,
  BudgetWindow,
  BudgetScope,
  BudgetLevel,
  BudgetState,
} from './budget/types.js';
export { windowKey, windowExpirySeconds } from './budget/window.js';
export { roundUsd, scopeKey } from './budget/store.js';
export type { BudgetStore } from './budget/store.js';
export { InMemoryBudgetStore } from './budget/in-memory-store.js';
export { RedisBudgetStore } from './budget/redis-store.js';
export type {
  RedisLike,
  RedisBudgetStoreOptions,
} from './budget/redis-store.js';
export { BudgetLedger, budgetLevel, evaluateBudget } from './budget/ledger.js';
export type { BudgetLedgerOptions } from './budget/ledger.js';
