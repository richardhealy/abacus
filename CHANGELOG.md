# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
