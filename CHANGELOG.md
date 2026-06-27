# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
