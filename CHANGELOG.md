# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — 2026-06-28
- Documentation phase, deliverable (c): the **architecture dossier** at
  [`docs/architecture.md`](docs/architecture.md). It explains how abacus is put
  together for an engineer who wants to understand, extend, or integrate it
  without reading every line of source: the observation-vs-enforcement split as
  the one organizing idea; a Mermaid **component map** plus a
  module→concern→spec-milestone table (middleware / attribution / pricing /
  budget / policy / observability / usage); the small, dependency-free data
  vocabulary that flows between layers (`TokenUsage` / `MeterRecord` /
  `Attribution` / `BudgetState` / `PolicyAction`); a Mermaid **sequence diagram**
  of control and data flow through a governed call (decide reads spend *before*
  and charge updates it *after*, one timestamp per call, the executed model's cost
  is charged, no-buffer streaming, the downshift resolver and cache hooks); a
  module-by-module walkthrough of `src/`; the **structural seams** (`MeterSink` /
  `BudgetStore` / `RedisLike` / `OTelTracerLike`+`OTelMeterLike` / `ModelResolver`
  / `GovernanceCache` / `UsageRecordSource`) as a table; key design decisions and
  their trade-offs (two middlewares, decide-is-pure, non-atomic check-then-charge,
  fail-open, conservative policy defaults, nano-dollar rounding); the external
  dependency list; a **spec→code traceability table**; and a note on how the
  design pays off in the test strategy. Prose only — no behaviour change; the full
  `check` (lint + typecheck + 184 tests + build) and the TypeDoc generation (zero
  warnings) both stay green.
- Documentation phase, deliverable (b): the **API reference**, in two parts.
  (1) **TypeDoc** for the library surface — a `typedoc.json` (entry point
  `src/index.ts`, internals excluded, link validation on, warnings treated as
  errors) and an `npm run docs:api` script that renders a documented page per
  module from the deliverable-(a) doc comments. It generates with zero warnings;
  the one external `@ai-sdk/provider` type link is resolved via
  `externalSymbolLinkMappings`. The generated `docs/api/` output is gitignored
  (reproducible from the comments at any commit) and excluded from ESLint, so the
  source of truth stays the doc comments. (2) **`docs/api.md`** for the HTTP
  surface — the `/usage` JSON endpoint (`usageHandler`) and the HTML dashboard
  (`dashboardHandler`): how to mount them, the `UsageRecordSource` read seam,
  authentication (none built in — mount behind your own access control), the
  shared `dimension` / `since` / `until` query parameters, the
  `UsageReport` / `RollupEntry` / `TokenUsage` response shapes with a worked JSON
  example, and the `400` / `405` / `500` error cases for both handlers. Tooling
  only — no behaviour change; the full `check` (lint + typecheck + 184 tests +
  build) stays green (TypeDoc pulled TypeScript 5.7 → 5.9, within the declared
  `^5.7` range).
- Documentation phase, deliverable (a): TSDoc `@module` headers across the whole
  public surface. Every source module now opens with a `@module` block (the
  barrel `src/index.ts` with `@packageDocumentation`) that states the module's
  intent and its role in the architecture — metering, attribution, pricing,
  budgets, the policy engine, enforcement, observability, and the usage/dashboard
  surface — so TypeDoc (deliverable b) will render a described page per module
  instead of attaching stray comments to private helpers. The per-symbol
  function and type docs written during the build phase were already in place;
  this pass also gave the few `*Options` and `RollupOptions` interfaces that
  documented only their fields an interface-level summary. Comments only — no
  behaviour change; the full `check` (lint + typecheck + 184 tests + build)
  stays green.

## [1.0.0] - 2026-06-28

### Added — 2026-06-28
- Release **1.0.0** (completes milestone M6 and the v1 spec) — every milestone
  (M0–M6) and every definition-of-done item is implemented and the full suite
  (184 tests) is green, so the API is tagged stable at `1.0.0`. Made the package
  publish-ready: bumped the version from `0.0.0`, added a `LICENSE` file (MIT, to
  match the long-declared `license` field), `repository` / `homepage` / `bugs` /
  `author` metadata, `sideEffects: false` so bundlers can tree-shake the unused
  surface, `LICENSE` to the published `files`, and a `prepublishOnly` script that
  runs the full `check` (lint + typecheck + test + build) so a broken build can
  never be published.
- Dashboard screenshot in the README (`docs/dashboard.png`) — a render of the
  spend-by-dimension dashboard over a representative week of spend across five
  tenants (the Opus-heavy `acme` tenant dominating the bill), produced by
  `renderUsageDashboard`. This is the visual the M6 "small dashboard ... showing
  spend by dimension" milestone calls for; the first of M6's two closing items.
  Only a tagged release now remains.
- Spend dashboard (milestone M6, first part): `dashboardHandler({ source })` — the
  HTML companion to `usageHandler`. Same Web Fetch `(Request) => Response` shape
  over the same `dimension`/`since`/`until` query surface, but renders the
  spend-by-dimension `UsageReport` as a self-contained HTML page instead of JSON,
  delivering the spec's "small dashboard ... showing spend by dimension". The page
  shows headline totals (spend / calls / tokens) and one table per dimension, each
  row carrying its calls, tokens, cost, and a bar for its share of total spend.
  It is server-rendered with inline styles only — no client JS, no external
  assets, no added dependency — and HTML-escapes every dynamic value so an
  attacker-controlled tenant id cannot inject markup. Hardened like the JSON
  endpoint: `400` on a bad query, `405` on a non-`GET` (with `Allow`), `500` on a
  source failure, each as a small HTML error page; never throws.
- `renderUsageDashboard(report, { title? })` — the pure, deterministic renderer
  behind the handler (the same `UsageReport` → the same markup), exported for
  building the dashboard outside HTTP (a static snapshot, a screenshot, an email).
- Factored the shared `dimension`/`since`/`until` parsing into
  `usageReportOptionsFromQuery` so the JSON endpoint and the dashboard parse the
  query identically and can never drift; `usageHandler` refactored onto it with no
  behaviour change. The offline example now serves the dashboard; 18 new unit
  tests cover the pure renderer and the handler (every branch and error status).
- The `/usage` endpoint (completes milestone M5): `usageHandler({ source })` — a
  framework-agnostic Web Fetch handler (`(Request) => Response`) that serves the
  spend-by-dimension view as JSON. Mounts in Next.js / Hono / Bun / Deno /
  Cloudflare Workers in one line with no added dependency, reading records through
  a `UsageRecordSource` seam (`() => MeterRecord[] | Promise<…>`) — the read-side
  analogue of `MeterSink` (`source: () => sink.records` for the in-memory sink).
  Query params: `dimension` (repeated or comma-separated), and `since`/`until`
  to window the report to a `[since, until)` range (since inclusive, until
  exclusive). Returns JSON `200` with the report, `400` on bad params, `405` for a
  non-`GET` method, and `500` if the source throws — it never propagates an
  exception. This delivers the "spend by tenant/feature is visible via `/usage`"
  definition-of-done item; the dashboard over it is M6.
- `buildUsageReport(records, options)` — the pure, deterministic core behind the
  endpoint: filters records to the window and rolls them up by each requested
  dimension via the shared `rollupByDimension`, returning
  `{ window, totals, byDimension }`. Exported (with `UsageReport`,
  `UsageReportOptions`, `UsageWindow`, `UsageTotals`) for building the same view
  without HTTP. The offline example now serves a live `/usage?dimension=tenant`
  response; 22 new unit tests cover the report and the handler.
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

### Fixed — 2026-06-28
- Dashboard share bars rendered collapsed: the `td.share` cell was
  `display:flex`, which takes the cell out of the table's column-width model, so
  its `width` was ignored and the `flex:1` bar shrank to its content width
  (a near-invisible sliver). The bar and percentage now sit in an inner
  `.share-wrap` flex row inside a normal `width:34%` table cell, and the bar has a
  `min-width` so its track is always visible. Markup-compatible (the existing
  dashboard tests are unchanged and still pass); the renderer stays pure and
  deterministic.

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

[Unreleased]: https://github.com/richardhealy/abacus/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/richardhealy/abacus/releases/tag/v1.0.0
