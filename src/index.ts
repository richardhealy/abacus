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
