# Progress

Milestone checklist derived from [`spec.md`](spec.md). Status legend:
☐ Not started · ◐ In progress · ☑ Done · ⊘ Blocked.

## Milestones

- **☑ M0 — Scaffold.** TS project, sample wrapped call, CI green.
  - [x] TypeScript project (strict, ESM, NodeNext) with npm scripts.
  - [x] Toolchain: vitest, ESLint (flat config), `tsc` build to `dist/`.
  - [x] GitHub Actions CI: lint → typecheck → test → build.
  - [x] `meteringMiddleware` wraps a model in one line via `wrapLanguageModel`.
  - [x] Normalized `TokenUsage` + `MeterRecord` + pluggable `MeterSink`.
  - [x] `InMemoryMeterSink` for tests / offline example.
  - [x] Runnable offline example (`npm run example`) + unit tests (13).

- **☑ M1 — Metering.** Middleware records tokens/latency/cost, attribution tags.
  - [x] Records tokens + latency on the `generate` path.
  - [x] Cost per record — computed from the price table when `prices` is set.
  - [x] Attribution dimensions (tenant / feature / user, plus free-form tags)
        tagged onto each record — read per-call from `providerOptions.abacus`,
        merged over an optional static middleware default.
  - [x] `rollupByDimension` / `InMemoryMeterSink.rollup(dimension)` — spend &
        usage grouped by a dimension, sorted by cost, deterministic; the basis
        for the M5 `/usage` view.
  - [x] Meter the streaming path (`wrapStream`): parts flow through a tap that
        reads usage from the terminal `finish` part and records once the stream
        drains. Buffered and streaming paths share one record-building helper, so
        a streamed call is priced and attributed identically. A stream that
        closes without a `finish` part records zero usage rather than nothing.

- **☑ M2 — Pricing.** Auditable price table, deterministic cost math, per-model tests.
  - [x] `ModelPrice` / `PriceTable` / `CostBreakdown` types; `defaultPrices` config.
  - [x] `priceFor` (exact + bare-id fallback), `costOf`, `computeCost`.
  - [x] Cache reads billed at the cache rate; reasoning not double-charged.
  - [x] Nano-dollar rounding so summed spend is deterministic and drift-free.
  - [x] Wired into the middleware (`prices` option) + `InMemoryMeterSink.totalCost()`.
  - [x] Unpriced models surfaced via `onUnpricedModel`, not silently billed at 0.
  - [x] 17 new unit tests (cost math + middleware pricing).
- **☑ M3 — Budgets.** Redis soft/hard limits, daily/monthly windows, concurrency-safe.
  - [x] `Budget` config: per-dimension (tenant/feature/user) soft + hard limits
        in USD, over a `daily`/`monthly` window.
  - [x] `BudgetStore` interface (the Redis seam, mirroring `MeterSink`) with an
        atomic `addSpend` contract — no lost increments under concurrency.
  - [x] `InMemoryBudgetStore` — concurrency-safe by construction (synchronous
        read-modify-write); 1000 concurrent charges sum exactly.
  - [x] `RedisBudgetStore` over a minimal `RedisLike` client (no runtime Redis
        dependency): atomic `INCRBYFLOAT` accounting + window-boundary `EXPIRE`
        so buckets self-clean; tested against an in-memory fake.
  - [x] UTC windowing (`windowKey` / `windowExpirySeconds`): pure, deterministic
        bucket keys and TTLs; spend resets at a window boundary with no cron.
  - [x] `BudgetLedger` ties attribution → budgets: `charge`/`check` apply or read
        spend across every budget a call falls under; `budgetLevel` /
        `evaluateBudget` derive `ok`/`soft`/`hard` purely (the seam for M4).
  - [x] 35 new unit tests (windowing, both stores incl. concurrency, ledger).
- **☑ M4 — Policy engine.** Pure `(budget, request) → action`; downshift / cache / refuse, per-branch tests.
  - [x] `PolicyAction` (discriminated union): `allow` / `downshift` (carries the
        replacement + original model) / `cache` / `refuse` (carries the reason),
        each non-`allow` action stamped with the triggering `BudgetState`.
  - [x] `Policy` config: a `PolicyRule` per level (`soft` / `hard`), with safe
        defaults — observe at soft, refuse at hard — so a policy must opt into
        degradation by naming a downshift target.
  - [x] `Downshift` target in three auditable forms (fixed string / record map /
        function); `resolveDownshift` is pure and treats a self-target as no-op.
  - [x] `decide(policy, states, request)` — pure, never throws: picks the most
        severe budget level (`mostSevere`, hard > soft > ok, fraction tie-break)
        and applies that level's rule. A downshift that can't resolve a cheaper
        model falls through to a configurable `else` (default `allow`).
  - [x] `describeBudgetState` builds the human-readable `reason` (overridable per
        rule), denominated against the crossed level's limit.
  - [x] 25 new unit tests — each branch (allow / downshift / cache / refuse, plus
        the downshift fall-through and most-severe selection) tested in isolation.
- **☑ Enforcement (M3 + M4 in the call path).** `enforcementMiddleware` executes
  the policy decision and charges spend — the companion to `meteringMiddleware`.
  - [x] `enforcementMiddleware`: before each call it reads the budgets the call
        falls under (`BudgetLedger.check`), runs `decide`, and executes the
        action — **allow** (run as requested), **downshift** (run a cheaper model
        via a `resolveModel` seam, falling back to the requested model if the
        target can't be resolved), **cache** (serve a `GovernanceCache` hit, else
        fall through to the live call), **refuse** (throw `BudgetExceededError`).
  - [x] After any executed call it charges the *executed* model's cost back to the
        ledger (so a downshift accrues the cheaper rate), priced from the table —
        decision reads spend before, charge updates it after, so a crossed limit
        governs the next call.
  - [x] Both the buffered and streaming paths enforced; the stream charges once it
        drains via the same non-buffering tap the metering path uses.
  - [x] Cross-cutting and non-breaking: a ledger read/write failure routes to
        `onError` and the call **fails open** rather than erroring; an unpriced
        executed model is surfaced via `onUnpricedModel`, not charged.
  - [x] `BudgetExceededError` carries the triggering `BudgetState` and reason.
  - [x] 13 new unit tests — every branch on both paths, cost charged per branch,
        downshift fall-back, cache hit/miss, fail-open on read, surviving a failed
        charge, and unpriced-model handling.
- **☑ M5 — Observability.** OpenTelemetry `gen_ai.*` spans via watchtower; `/usage` rollups.
  - [x] `otelMeterSink` — a `MeterSink` that emits each metered call as
        OpenTelemetry GenAI telemetry through watchtower: one back-dated
        `gen_ai.*` span per call (started at `timestamp - latencyMs`, ended at
        `timestamp`, so it spans the real call window without holding a span open)
        and the GenAI metrics (`gen_ai.client.token.usage` /
        `gen_ai.client.operation.duration` histograms + an `abacus.cost.usd`
        counter attributed by tenant/feature/user — the spend-by-dimension view).
  - [x] Pure `gen_ai.*` attribute mapping (`genAiSpanAttributes` /
        `genAiMetricAttributes` / `attributionAttributes` / `spanName`):
        GenAI-semconv keys (`gen_ai.system`, `gen_ai.request.model`,
        `gen_ai.usage.*`) plus abacus-namespaced cost / token-breakdown /
        attribution attributes. Cost omitted when a call is unpriced, so an
        unpriced call is distinguishable from a free one.
  - [x] No runtime OTel dependency: written against a structural
        `OTelTracerLike` / `OTelMeterLike` seam (mirroring `RedisLike`) that a
        real OTel `Tracer` / `Meter` satisfies as-is; tracer and/or meter, at
        least one required. Like every sink, a throwing tracer/meter routes to
        metering's `onError` and never breaks the wrapped call.
  - [x] 13 new unit tests — pure attribute mapping, span back-dating/kind/attrs,
        the three metrics + units, unpriced-cost skip, tracer-only / meter-only /
        both, custom operation name, and end-to-end through `meteringMiddleware`.
  - [x] `/usage` endpoint: spend-by-dimension rollups over a queryable source.
        Pure `buildUsageReport(records, options)` filters records to a
        `[since, until)` window and rolls them up by each requested dimension
        (reusing `rollupByDimension`), returning `{ window, totals, byDimension }`.
        `usageHandler({ source })` wraps it as a framework-agnostic Web Fetch
        handler (`(Request) => Response`) — mounts in Next.js / Hono / Bun / Deno
        / Workers in one line, no added dependency. Query params: `dimension`
        (repeated or comma-separated), `since`, `until`; JSON `400`/`405`/`500`
        on bad input / wrong method / source failure, never throwing.
  - [x] 22 new unit tests — the pure report (totals, per-dimension rollups,
        window edges, dimension subset, unattributed/custom key, unpriced cost,
        empty) and the handler (JSON shape + content type, dimension parsing,
        window query, async source, every error status).
- **◐ M6 — Dashboard + ship.** Spend-by-dimension view, README screenshot, release.
  - [x] `renderUsageDashboard(report, { title? })` — a pure, deterministic renderer
        that turns a `UsageReport` into a **self-contained HTML page**: headline
        totals (spend / calls / tokens) plus one table per dimension, each row
        carrying its calls, tokens, cost, and a bar showing its share of total
        spend (rows already cost-sorted by `rollupByDimension`). Inline styles
        only — no scripts, no external assets — and every dynamic value is
        HTML-escaped, so an attacker-controlled tenant id cannot inject markup.
  - [x] `dashboardHandler({ source, dimensions?, unattributedKey?, title? })` —
        the HTML companion to `usageHandler`: the same Web Fetch
        `(Request) => Response` shape over the same `dimension`/`since`/`until`
        query surface, rendering the dashboard instead of JSON. Mounts in
        Next.js / Hono / Bun / Deno / Workers in one line. Hardened like the JSON
        endpoint — `400` (bad query) / `405` (non-GET, with `Allow`) / `500`
        (source failure) as small HTML error pages; never throws.
  - [x] Shared `usageReportOptionsFromQuery` (in `src/usage/query.ts`) — the
        `dimension`/`since`/`until` parsing the JSON endpoint and the dashboard
        now both go through, so the two surfaces stay in lock-step. `endpoint.ts`
        refactored onto it (no behaviour change; endpoint tests unchanged).
  - [x] Offline example serves the dashboard; 18 new unit tests (pure renderer:
        totals, per-dimension tables, cost-sort order, dimension subset, HTML
        escaping, empty state, window line, custom title, determinism; handler:
        content type, dimension/window query, every error status, async source,
        escaped error message, title passthrough).
  - [ ] Dashboard screenshot embedded in the README.
  - [ ] Tagged release (version bump, publish-ready package).

## Definition of done (from spec)

- [x] A wrapped call is metered and attributed with one line of integration
      (wrap once; tag per call via `providerOptions.abacus`).
- [x] Crossing a soft limit downshifts (or caches); crossing a hard limit refuses
      cleanly — `enforcementMiddleware` reads the budget level, runs `decide`, and
      executes the action in the call path (downshift to a cheaper model, serve a
      cache hit, or throw `BudgetExceededError`), charging the executed cost back
      to the ledger. Both buffered and streaming paths.
- [x] Budget accounting is correct under concurrent calls (tested) — `addSpend`
      is atomic in both stores; concurrent-charge tests assert exact totals.
- [x] Spend by tenant/feature is visible via `/usage` and in the tracing tool.
      Tracing tool: `otelMeterSink` emits `gen_ai.*` spans (attributed with
      `abacus.tenant`/`feature`/`user`) and an `abacus.cost.usd` counter keyed by
      those dimensions. `/usage`: `usageHandler` serves the spend-by-dimension
      report as JSON over any record source. The dashboard (M6) renders this.

## Notes / decisions

- **AI SDK 6** pins the `ai-v6` line (`ai@6.0.213`), whose provider spec is **V3**
  (`LanguageModelV3Middleware`). The public middleware type comes from
  `@ai-sdk/provider`, added as an explicit dependency.
- **Metering never breaks the call.** Sink failures route to `onError` (default:
  log) and the wrapped model call always returns. The sink is awaited so records
  are not silently dropped; production sinks should be fast / async-batched. On
  the streaming path the sink is awaited inside the tap's `flush`, so a throwing
  sink surfaces through `onError`, never as a stream error to the caller.
- **Streaming is metered without buffering the stream** (M1): `wrapStream` pipes
  the model's parts through a `TransformStream` that forwards each part untouched
  and captures usage from the terminal `finish` part, recording once on `flush`.
  Latency spans the whole call (start of `doStream` to stream drain), the
  analogue of the buffered path's call duration. Both paths build the record
  through one shared helper, so streamed spend is attributed and priced exactly
  like buffered spend.
- **Observation vs. enforcement split** (per spec): abacus owns enforcement;
  telemetry is emitted through watchtower. The `MeterSink` interface is the seam
  where an OTel/watchtower sink will plug in (M5).
- **Cost math is deterministic** (M2): rates live in plain config as USD per 1M
  tokens; per-call cost is rounded to nano-dollars so summing thousands of small
  costs never accumulates floating-point dust. Pricing is optional — metering
  runs without it — and an unpriced model is left cost-less (surfaced via
  `onUnpricedModel`) rather than silently billed at `0`.
- **Budgets are a spend ledger, not a policy** (M3): the budget layer only
  *measures* — it accumulates spend per scope/window and reports which threshold
  it has crossed (`ok`/`soft`/`hard`). Deciding what to *do* (downshift / cache /
  refuse) is the policy engine (M4). This keeps the store dumb and durable, the
  evaluation pure, and the decision testable in isolation, matching the spec's
  observation/enforcement split.
- **Concurrency safety via atomic add** (M3): the overspend race is two callers
  reading the same total and writing back `total + delta`, losing one. Both
  stores avoid it by never doing a read-then-write: the in-memory store mutates
  in one synchronous step (atomic under Node's event loop), and the Redis store
  uses server-side `INCRBYFLOAT`. A throwaway 1000-concurrent-charge test on each
  asserts the sum is exact. The store is clock-free (timestamps are passed in),
  so windowing stays pure and tests place spend in a chosen day/month.
- **The policy decision is pure** (M4): `decide(policy, states, request)` is a
  total function with no I/O — it takes the budget states a call falls under (from
  the ledger) plus the requested model, and returns an `allow` / `downshift` /
  `cache` / `refuse` action. This is the spec's design rule: *decide* is pure and
  unit-testable per branch; *execute* (swap the model, serve cache, throw) is the
  middleware's job in a later increment. The action carries its triggering
  `BudgetState` and a reason so the executor can trace/log without re-deriving why.
- **Conservative defaults, opt-in degradation** (M4): the default soft rule is
  `allow` (observe only) and the default hard rule is `refuse`. Downshift/cache
  never happen unless the operator configures them, because there is no universal
  cheaper model — a downshift needs an explicit target. A downshift that can't
  resolve a target for the requested model falls through to a configurable `else`
  (default `allow`), so a non-downshiftable call proceeds rather than failing
  closed; set `else: { kind: 'refuse' }` to fail closed instead.
- **Enforcement executes; metering observes** (call-path wiring): the pure
  `decide` from M4 is run by `enforcementMiddleware`, a second AI SDK middleware
  composed alongside `meteringMiddleware`. Keeping them separate preserves the
  spec's observation/enforcement split — metering writes to a sink, enforcement
  reads/charges the budget ledger and acts on the decision. The check-then-charge
  is deliberately *not* atomic: a call's cost is unknown until it returns, so the
  decision reads spend before the call and the charge updates it after, meaning a
  crossed limit governs the *next* call (the realistic model; the store's
  `addSpend` is still atomic, so totals never race).
- **Downshift needs a model resolver** (call-path wiring): `wrapLanguageModel`
  binds one model, but a downshift must *call a different one*. AI SDK middleware
  can't reroute by id alone, so enforcement takes a `resolveModel(id) => model`
  seam (a gateway call or `createProviderRegistry` lookup) and invokes the
  resolved model's `doGenerate`/`doStream` directly. If the target can't be
  resolved the call falls back to the requested model — failing open, consistent
  with the engine's own downshift fall-through. Cache is served through an
  optional `GovernanceCache` hook because abacus does not own a cache; a miss
  falls through to the live call.
- **Enforcement never breaks the call** (call-path wiring): like metering, a
  ledger read or write failure routes to `onError` and the call proceeds (fails
  open) — a store outage degrades governance, it does not take down every LLM
  call. Operators who need fail-closed semantics wrap the ledger. Cost is charged
  from the *executed* model's id, so a downshift accrues the cheaper rate.
- **Observe through watchtower, don't reinvent tracing** (M5): per the spec,
  abacus owns *enforcement* and emits *observation* as OpenTelemetry. `otelMeterSink`
  is a `MeterSink`, so it composes with the existing metering path — no new
  call-path wiring. Each record becomes one `gen_ai.*` span and the GenAI metrics,
  using the standard semconv keys so spend appears alongside any other
  instrumented LLM call. The span is **back-dated** (started at
  `timestamp - latencyMs`, ended at `timestamp`) because the call has already
  returned by the time the sink runs — this reproduces the real call window
  without holding a span open across the call (which a `MeterSink` can't do; it
  only sees a completed record). The cost lives in an `abacus.cost.usd` namespace
  (GenAI semconv has no cost key) and the cost *counter* carries the attribution
  dimensions so spend aggregates by tenant/feature/user in the metrics backend —
  the "tracing tool" half of the spec's spend-visibility goal. As with `RedisLike`,
  the sink targets a structural OTel seam (`OTelTracerLike`/`OTelMeterLike`) so a
  real `@opentelemetry/api` `Tracer`/`Meter` drops in with no runtime dependency.
  The attribute mapping is pure (`genAiSpanAttributes`/`genAiMetricAttributes`)
  and unit-tested in isolation, matching the project's decide-is-pure ethos.
- **`/usage` is a pure report plus a Web-standard handler** (M5): the
  spend-by-dimension view splits the same way the rest of abacus does — a pure,
  deterministic `buildUsageReport(records, options)` (window-filter then roll up
  by dimension via the shared `rollupByDimension`, so the endpoint and the
  in-memory sink compute spend identically) and a thin `usageHandler` that only
  parses the request and serializes the report. The handler is a **Web Fetch**
  `(Request) => Response`, not Express-specific, because AI SDK 6 is built on web
  standards: it drops into Next.js route handlers, Hono, Bun, Deno, and
  Cloudflare Workers unchanged and adds no dependency. Records are read through a
  `UsageRecordSource` seam (`() => MeterRecord[] | Promise<…>`) — the read-side
  analogue of `MeterSink`'s write side — so the in-memory sink is a one-liner
  (`source: () => sink.records`) and a durable store fetches its rows. The window
  is `[since, until)` (since inclusive, until exclusive) so adjacent windows
  partition records without double-counting. Like the call path, the endpoint
  never throws: a failing source becomes a `500`, bad params a `400`, a non-`GET`
  a `405`.
- **The dashboard is the report, rendered** (M6): the spec asks for "a small
  dashboard ... showing spend by dimension", and abacus already computes that
  spend once — `buildUsageReport`. So the dashboard adds no new data path: it is a
  pure `renderUsageDashboard(report)` over the *same* `UsageReport` the `/usage`
  endpoint serves, wrapped in a `dashboardHandler` that is the HTML twin of
  `usageHandler` (same Web Fetch shape, same query surface). The two handlers were
  starting to duplicate query parsing, so `dimension`/`since`/`until` parsing moved
  to one shared `usageReportOptionsFromQuery`; JSON and HTML can never drift. The
  page is deliberately **self-contained and dependency-free** — server-rendered
  HTML with inline styles, no client JS, no charting library, no external assets —
  matching abacus's "no runtime dependency beyond `ai`" ethos and meaning the
  output is a plain string that drops into any response *or* a static file (so a
  README screenshot is just rendering one report). Rendering is pure and
  deterministic (the decide-is-pure ethos again) and **HTML-escapes every dynamic
  value**, because dimension keys are attacker-controlled (a tenant id from a
  caller) and must not be able to inject markup.
- **Redis without a runtime dependency** (M3): `RedisBudgetStore` is written
  against a structural `RedisLike` (just `incrbyfloat` / `expire` / `get`), so an
  `ioredis` client drops in and abacus keeps its dependency surface to `ai` +
  `@ai-sdk/provider`. Each window bucket gets a TTL landing on the window
  boundary, so spend resets and stale buckets clean themselves with no cron.
- **Attribution rides on `providerOptions`** (M1): per-call tags are read from
  the `abacus` namespace of an AI SDK call's `providerOptions`, so one wrapped
  model serves every tenant and the one-line integration is preserved (no
  per-tenant wrapping). A static middleware default merges underneath, per-call
  values winning field by field. Malformed tags are ignored, never thrown —
  attribution is best-effort metadata and must not break the wrapped call. The
  three named dimensions (tenant/feature/user) are first-class because M3 budgets
  key on them; arbitrary extra context goes in `tags`. `rollupByDimension` is a
  pure function over records so the M5 `/usage` endpoint and the in-memory sink
  share one implementation.
