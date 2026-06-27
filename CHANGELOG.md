# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
