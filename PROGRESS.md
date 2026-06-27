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
- **☐ M4 — Policy engine.** Pure `(budget, request) → action`; downshift / cache / refuse, per-branch tests.
- **☐ M5 — Observability.** OpenTelemetry `gen_ai.*` spans via watchtower; `/usage` rollups.
- **☐ M6 — Dashboard + ship.** Spend-by-dimension view, README screenshot, release.

## Definition of done (from spec)

- [x] A wrapped call is metered and attributed with one line of integration
      (wrap once; tag per call via `providerOptions.abacus`).
- [ ] Crossing a soft limit downshifts (or caches); crossing a hard limit refuses
      cleanly. *(M3 supplies the budget level; M4 wires it into the call path.)*
- [x] Budget accounting is correct under concurrent calls (tested) — `addSpend`
      is atomic in both stores; concurrent-charge tests assert exact totals.
- [ ] Spend by tenant/feature is visible via `/usage` and in the tracing tool.

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
