# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — 2026-06-28
- Observability (milestone M5, first half): `otelMeterSink` — a `MeterSink` that
  emits each metered call as OpenTelemetry **`gen_ai.*`** telemetry through
  watchtower. Per call it creates one back-dated `gen_ai.*` span (started at
  `timestamp - latencyMs`, ended at `timestamp`, so it spans the real call window)
  carrying the GenAI-semconv attributes plus abacus's `abacus.cost.usd` and the
  attribution (`abacus.tenant`/`feature`/`user`), and records the GenAI metrics:
  the `gen_ai.client.token.usage` and `gen_ai.client.operation.duration`
  histograms, and an `abacus.cost.usd` counter attributed by tenant/feature/user
  (the spend-by-dimension view in the metrics backend). This delivers the
  "tracing tool" half of the spec's spend-visibility goal; the `/usage` endpoint
  is next.
- No runtime OpenTelemetry dependency: `otelMeterSink` targets a structural
  `OTelTracerLike`/`OTelMeterLike` seam (mirroring `RedisLike`) that a real OTel
  `Tracer`/`Meter` satisfies as-is; provide a tracer, a meter, or both. The pure
  `gen_ai.*` attribute mappers (`genAiSpanAttributes`, `genAiMetricAttributes`,
  `attributionAttributes`, `spanName`) and the metric-name constants are exported.
  13 new unit tests cover the attribute mapping, span back-dating, the three
  metrics and their units, the unpriced-cost skip, tracer-only/meter-only/both,
  and an end-to-end span through `meteringMiddleware`.
- Enforcement in the call path: `enforcementMiddleware` *executes* the policy
  decision from M4 — the companion to `meteringMiddleware`. Before each call it
  reads the budgets the call falls under (`BudgetLedger.check`), runs `decide`,
  and acts: **allow** (run as requested), **downshift** (run a cheaper model via a
  `resolveModel` seam, falling back to the requested model if the target can't be
  resolved), **cache** (serve a `GovernanceCache` hit, else fall through to the
  live call), or **refuse** (throw `BudgetExceededError`). It then charges the
  *executed* model's cost back to the ledger, so a downshift accrues the cheaper
  rate and a crossed limit governs the next call. Both the buffered and streaming
  paths are enforced. This completes the spec's "soft → downshift/cache, hard →
  refuse" definition-of-done item.
- `BudgetExceededError` (carries the triggering `BudgetState` and reason),
  `GovernanceCache` (optional read-through cache hook), and `ModelResolver` are
  exported. Enforcement is non-breaking: a ledger read/write failure routes to
  `onError` and the call fails open; an unpriced executed model is surfaced via
  `onUnpricedModel` rather than silently uncharged. The offline example now runs a
  metered **and** governed model across three tenants to show allow / downshift /
  refuse; 13 new unit tests cover every branch on both paths.

### Added — 2026-06-27
- Policy engine (milestone M4): a pure `decide(policy, states, request) → action`
  that turns the budget level a call has crossed into a decision —
  `allow` / `downshift` (to a cheaper model) / `cache` / `refuse`. Modelled as a
  discriminated `PolicyAction` union; each non-`allow` action carries the
  triggering `BudgetState` and a human-readable `reason`. The decision is pure and
  side-effect free (the spec's observation/enforcement split): the middleware will
  *execute* it in a later increment.
- `Policy` config holds a `PolicyRule` per level (`soft` / `hard`) with safe
  defaults — observe at soft, refuse at hard — so degradation is opt-in. The
  `downshift` rule's target is auditable in three forms (a fixed model string, a
  `{ requested → replacement }` map, or a function); `resolveDownshift` resolves
  it purely and treats a self-target as no-op. A downshift that can't resolve a
  cheaper model falls through to a configurable `else` (default `allow`).
- `mostSevere` (hard > soft > ok, fraction tie-break) selects the governing
  budget; `describeBudgetState` builds the decision reason. The offline example
  now derives a policy decision from the acme tenant's budget state; 25 new unit
  tests cover each branch in isolation.

### Added — 2026-06-27
- Budgets (milestone M3): soft/hard spend limits per attribution scope
  (tenant / feature / user) over a `daily` or `monthly` window. A `BudgetStore`
  interface abstracts the durable counter, with two implementations — an
  `InMemoryBudgetStore` for tests/single-process use and a `RedisBudgetStore`
  for multi-process deployments. Both are **concurrency-safe**: spend is added
  atomically (synchronous in memory, `INCRBYFLOAT` in Redis), so concurrent
  charges never lose an increment (the overspend race), proven by a
  1000-concurrent-charge test on each.
- `BudgetLedger` ties attribution to budgets: `charge` applies an attributed
  cost to every budget the call falls under and `check` reads current state, each
  returning a `BudgetState` (spend, `ok`/`soft`/`hard` level, fraction of the
  hard limit). `budgetLevel` / `evaluateBudget` derive the level purely — the
  seam the policy engine (M4) will consume.
- UTC windowing (`windowKey` / `windowExpirySeconds`): deterministic bucket keys
  and TTLs so spend resets at a window boundary with no scheduled job; Redis
  buckets self-expire. `RedisBudgetStore` is written against a minimal `RedisLike`
  client, so abacus keeps its runtime dependencies to `ai` + `@ai-sdk/provider`.
- Offline example now charges the acme tenant's metered cost into a monthly
  budget and prints the resulting state; 35 new unit tests.

### Added — 2026-06-27
- Streaming metering (completes milestone M1): `meteringMiddleware` now wraps the
  streaming path (`streamText` / `streamObject`) as well as the buffered one. The
  stream parts flow through a `TransformStream` untouched; usage is read from the
  terminal `finish` part and one `MeterRecord` is written when the stream drains,
  so the caller sees an identical stream and metering adds no buffering. Buffered
  and streaming paths share a single record-building helper, so a streamed call
  is attributed and priced exactly like a buffered one. A stream that closes
  without a `finish` part records zero usage rather than nothing, and a throwing
  sink routes to `onError` instead of surfacing as a stream error.
- Factored a shared `zeroUsage()` helper (the neutral `TokenUsage`), now reused
  by the in-memory sink's totals and the streaming fallback. The offline example
  streams a third (tenant-tagged) call; 8 new unit + end-to-end tests.

### Added — 2026-06-27
- Attribution (milestone M1): tag metered calls by `tenant` / `feature` / `user`
  (plus free-form `tags`). The middleware reads per-call attribution from the
  `abacus` namespace of an AI SDK call's `providerOptions` and merges it over an
  optional static `attribution` default, so one wrapped model serves every tenant
  and the one-line integration is preserved. Each `MeterRecord` now carries an
  optional `attribution`.
- `rollupByDimension` and `InMemoryMeterSink.rollup(dimension)` group spend and
  usage by an attribution dimension, sorted by cost (descending), with records
  missing the dimension collected under `(unattributed)` — the basis for the
  forthcoming `/usage` view. Exposed `Attribution`, `AttributionDimension`,
  `RollupEntry`, `attributionFromProviderOptions`, and `mergeAttribution`.
- Offline example now tags two calls to different tenants and prints
  `sink.rollup('tenant')`; 20 new unit + end-to-end tests.

### Added — 2026-06-27
- Pricing (milestone M2): auditable `PriceTable` config in USD per 1M tokens
  (`defaultPrices`), plus deterministic cost math — `priceFor` (exact match with
  a bare-model-id fallback), `costOf` (per-category `CostBreakdown`), and
  `computeCost`. Cached input is billed at the discounted cache rate, reasoning
  tokens are not charged twice, and amounts are rounded to nano-dollars so summed
  spend never drifts.
- `meteringMiddleware` now accepts an optional `prices` table and stamps each
  `MeterRecord` with its `cost` (USD). Unpriced models are surfaced via an
  `onUnpricedModel` hook (warn-once) instead of silently billed at `0`.
- `InMemoryMeterSink.totalCost()` rolls up spend across recorded calls; the
  offline example now reports cost from the bundled price table.

### Added — 2026-06-27
- Scaffold (milestone M0): TypeScript/ESM project, vitest, ESLint flat config,
  and `tsc` build to `dist/`, with a GitHub Actions CI pipeline
  (lint → typecheck → test → build).
- `meteringMiddleware` — AI SDK 6 (`LanguageModelV3Middleware`) that meters the
  `generate` path: times the call and records normalized token usage. Sink
  failures route to an `onError` hook so metering never breaks the wrapped call.
- `TokenUsage` / `MeterRecord` / `MeterSink` types and `normalizeUsage`, which
  flattens the AI SDK's nested usage shape into flat counts that default to `0`.
- `InMemoryMeterSink` for tests and the offline example, with `records`, `count`,
  `totals()`, and `clear()`.
- Runnable offline example (`npm run example`) showing the one-line wrap, plus
  13 unit tests covering usage normalization, the sink, and the middleware.
