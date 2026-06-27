/**
 * abacus — a cost-governance layer for LLM calls.
 *
 * v1 surface (metering scaffold). Budgets, the policy engine, pricing, and the
 * `/usage` endpoint land in later milestones; see PROGRESS.md.
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
