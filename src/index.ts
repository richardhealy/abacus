/**
 * abacus — a cost-governance layer for LLM calls.
 *
 * v1 surface. Metering, attribution, pricing, budgets, the policy engine, its
 * enforcement in the call path, OpenTelemetry observability, the `/usage`
 * spend-by-dimension endpoint, and the HTML dashboard over it (M6) are in place;
 * see PROGRESS.md.
 */
export { meteringMiddleware } from './middleware/metering.js';
export type { MeteringOptions } from './middleware/metering.js';
export { InMemoryMeterSink } from './middleware/in-memory-sink.js';
export { normalizeUsage } from './middleware/usage.js';
export type { MeterRecord, MeterSink, TokenUsage } from './middleware/types.js';

// Enforcement (M4 wiring): execute the policy decision in the call path —
// downshift / cache / refuse — and charge spend back to the ledger.
export {
  enforcementMiddleware,
  BudgetExceededError,
} from './middleware/enforcement.js';
export type {
  EnforcementOptions,
  EnforcementErrorContext,
  GovernanceCache,
  ModelResolver,
} from './middleware/enforcement.js';

// Observability (M5): emit metered spend as OpenTelemetry gen_ai.* spans and
// metrics through watchtower — a structural OTel seam, no runtime OTel dependency.
export { otelMeterSink, SPAN_KIND_CLIENT } from './observability/otel-sink.js';
export type {
  OTelMeterSinkOptions,
  OTelTracerLike,
  OTelSpanLike,
  OTelSpanOptions,
  OTelMeterLike,
  OTelHistogramLike,
  OTelCounterLike,
  OTelInstrumentOptions,
  OTelTimeInput,
} from './observability/otel-sink.js';
export {
  genAiSpanAttributes,
  genAiMetricAttributes,
  attributionAttributes,
  spanName,
  DEFAULT_OPERATION_NAME,
  METRIC_GEN_AI_TOKEN_USAGE,
  METRIC_GEN_AI_OPERATION_DURATION,
  METRIC_ABACUS_COST_USD,
} from './observability/gen-ai.js';
export type {
  OTelAttributes,
  OTelAttributeValue,
} from './observability/gen-ai.js';

// Usage (M5): the spend-by-dimension `/usage` endpoint. A pure report builder
// plus a framework-agnostic Web Fetch handler over any record source.
export { buildUsageReport } from './usage/report.js';
export type {
  UsageReport,
  UsageReportOptions,
  UsageWindow,
  UsageTotals,
} from './usage/report.js';
export { usageHandler } from './usage/endpoint.js';
export type {
  UsageHandlerOptions,
  UsageRecordSource,
} from './usage/endpoint.js';

// Dashboard (M6): the spend-by-dimension view as a self-contained HTML page —
// a pure renderer plus a Web Fetch handler, the HTML companion to `usageHandler`.
export { dashboardHandler, renderUsageDashboard } from './usage/dashboard.js';
export type {
  DashboardHandlerOptions,
  DashboardRenderOptions,
} from './usage/dashboard.js';

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

// Policy engine (M4): pure `(budget state, request) → action`. Decides
// allow / downshift / cache / refuse; the middleware executes the decision.
export {
  decide,
  mostSevere,
  resolveDownshift,
  describeBudgetState,
  DEFAULT_SOFT_RULE,
  DEFAULT_HARD_RULE,
} from './policy/engine.js';
export type {
  Policy,
  PolicyRule,
  AllowRule,
  CacheRule,
  RefuseRule,
  DownshiftRule,
  PolicyRequest,
  PolicyAction,
  AllowAction,
  DownshiftAction,
  CacheAction,
  RefuseAction,
  Downshift,
} from './policy/types.js';
