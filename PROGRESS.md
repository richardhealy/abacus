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
  - [ ] Meter the streaming path (`wrapStream`), accumulating usage from stream parts.
  - [ ] Attribution dimensions (tenant / feature / user) tagged onto each record.
  - [ ] Cost per record (depends on M2 pricing).

- **☐ M2 — Pricing.** Auditable price table, deterministic cost math, per-model tests.
- **☐ M3 — Budgets.** Redis soft/hard limits, daily/monthly windows, concurrency-safe.
- **☐ M4 — Policy engine.** Pure `(budget, request) → action`; downshift / cache / refuse, per-branch tests.
- **☐ M5 — Observability.** OpenTelemetry `gen_ai.*` spans via watchtower; `/usage` rollups.
- **☐ M6 — Dashboard + ship.** Spend-by-dimension view, README screenshot, release.

## Definition of done (from spec)

- [ ] A wrapped call is metered and attributed with one line of integration.
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
