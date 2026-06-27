# abacus

A **cost-governance layer for LLM calls.** It meters and attributes every token,
enforces per-tenant budgets, and degrades gracefully when a budget tightens —
instead of silently overspending and finding out on the monthly invoice.

The architectural idea on show is a **policy engine that sits in the model-call
path** and can meter, attribute, cap, and downshift — all observable. It is built
as [Vercel AI SDK](https://ai-sdk.dev) middleware, so it wraps any model call
without the caller knowing.

> **Status:** early. The metering scaffold (milestone **M0**) is in place — one-line
> wrapping, normalized token metering, a pluggable sink, and green CI. Budgets, the
> policy engine, pricing, and the `/usage` endpoint are next. See
> [`PROGRESS.md`](PROGRESS.md) and [`spec.md`](spec.md).

## Install

```bash
npm install
```

Requires Node ≥ 20. The runtime depends only on `ai` (v6) and `@ai-sdk/provider`.

## Wrapping a call

Metering is one line. Wrap any AI SDK model with `meteringMiddleware` and every
call is metered automatically — the code calling `generateText` never changes.

```ts
// before — a plain model call, no governance
const model = gateway('anthropic/claude-opus-4');

// after — the same model, now metered (one line)
import { wrapLanguageModel } from 'ai';
import { meteringMiddleware, InMemoryMeterSink } from 'abacus';

const sink = new InMemoryMeterSink();

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: meteringMiddleware({ sink }),
});

// ...use `model` exactly as before...
await generateText({ model, prompt: 'What is the capital of France?' });

console.log(sink.totals());
// → { inputTokens: 42, outputTokens: 8, totalTokens: 50, cachedInputTokens: 0, reasoningTokens: 0 }
```

A runnable, offline version (using a mock model, no API keys) lives in
[`examples/wrap-call.ts`](examples/wrap-call.ts):

```bash
npm run example
```

## What it records

Each metered call produces a `MeterRecord`:

```ts
interface MeterRecord {
  modelId: string;     // e.g. "anthropic/claude-opus-4"
  provider: string;    // e.g. "gateway"
  timestamp: number;   // epoch ms when the call completed
  latencyMs: number;   // wall-clock duration of the model call
  usage: TokenUsage;   // normalized, flat token counts (never undefined)
}
```

`TokenUsage` flattens the AI SDK's nested, partially-undefined usage shape into
flat counts that default to `0` — so downstream cost math and rollups never have
to guard for missing fields.

Records go to a `MeterSink`. `InMemoryMeterSink` is provided for tests and local
development; durable sinks (Redis, OpenTelemetry via
[`watchtower`](spec.md)) plug into the same interface. **Metering never breaks the
wrapped call:** if a sink throws, the failure is routed to an `onError` hook and
the model call still returns.

## Development

```bash
npm run check      # lint + typecheck + test + build
npm test           # unit tests (vitest)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run build      # emit dist/
```

## License

MIT
