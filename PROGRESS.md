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

- **◐ M1 — Metering.** Middleware records tokens/latency/cost, attribution tags.
  - [x] Records tokens + latency on the `generate` path.
  - [x] Cost per record — computed from the price table when `prices` is set.
  - [x] Attribution dimensions (tenant / feature / user, plus free-form tags)
        tagged onto each record — read per-call from `providerOptions.abacus`,
        merged over an optional static middleware default.
  - [x] `rollupByDimension` / `InMemoryMeterSink.rollup(dimension)` — spend &
        usage grouped by a dimension, sorted by cost, deterministic; the basis
        for the M5 `/usage` view.
  - [ ] Meter the streaming path (`wrapStream`), accumulating usage from stream parts.

- **☑ M2 — Pricing.** Auditable price table, deterministic cost math, per-model tests.
  - [x] `ModelPrice` / `PriceTable` / `CostBreakdown` types; `defaultPrices` config.
  - [x] `priceFor` (exact + bare-id fallback), `costOf`, `computeCost`.
  - [x] Cache reads billed at the cache rate; reasoning not double-charged.
  - [x] Nano-dollar rounding so summed spend is deterministic and drift-free.
  - [x] Wired into the middleware (`prices` option) + `InMemoryMeterSink.totalCost()`.
  - [x] Unpriced models surfaced via `onUnpricedModel`, not silently billed at 0.
  - [x] 17 new unit tests (cost math + middleware pricing).
- **☐ M3 — Budgets.** Redis soft/hard limits, daily/monthly windows, concurrency-safe.
- **☐ M4 — Policy engine.** Pure `(budget, request) → action`; downshift / cache / refuse, per-branch tests.
- **☐ M5 — Observability.** OpenTelemetry `gen_ai.*` spans via watchtower; `/usage` rollups.
- **☐ M6 — Dashboard + ship.** Spend-by-dimension view, README screenshot, release.

## Definition of done (from spec)

- [x] A wrapped call is metered and attributed with one line of integration
      (wrap once; tag per call via `providerOptions.abacus`).
- [ ] Crossing a soft limit downshifts (or caches); crossing a hard limit refuses cleanly.
- [ ] Budget accounting is correct under concurrent calls (tested).
- [ ] Spend by tenant/feature is visible via `/usage` and in the tracing tool.

## Notes / decisions

- **AI SDK 6** pins the `ai-v6` line (`ai@6.0.213`), whose provider spec is **V3**
  (`LanguageModelV3Middleware`). The public middleware type comes from
  `@ai-sdk/provider`, added as an explicit dependency.
- **Metering never breaks the call.** Sink failures route to `onError` (default:
  log) and the wrapped model call always returns. The sink is awaited so records
  are not silently dropped; production sinks should be fast / async-batched.
- **Observation vs. enforcement split** (per spec): abacus owns enforcement;
  telemetry is emitted through watchtower. The `MeterSink` interface is the seam
  where an OTel/watchtower sink will plug in (M5).
- **Cost math is deterministic** (M2): rates live in plain config as USD per 1M
  tokens; per-call cost is rounded to nano-dollars so summing thousands of small
  costs never accumulates floating-point dust. Pricing is optional — metering
  runs without it — and an unpriced model is left cost-less (surfaced via
  `onUnpricedModel`) rather than silently billed at `0`.
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
