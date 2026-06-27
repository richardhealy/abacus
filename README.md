# abacus

A **cost-governance layer for LLM calls.** It meters and attributes every token,
enforces per-tenant budgets, and degrades gracefully when a budget tightens —
instead of silently overspending and finding out on the monthly invoice.

The architectural idea on show is a **policy engine that sits in the model-call
path** and can meter, attribute, cap, and downshift — all observable. It is built
as [Vercel AI SDK](https://ai-sdk.dev) middleware, so it wraps any model call
without the caller knowing.

> **Status:** early. Metering (**M0–M1**) and pricing (**M2**) are in place —
> one-line wrapping, normalized token metering, a pluggable sink, an auditable
> price table, and deterministic per-call cost. Budgets, the policy engine, and
> the `/usage` endpoint are next. See [`PROGRESS.md`](PROGRESS.md) and
> [`spec.md`](spec.md).

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
  cost?: number;       // computed spend in USD, when a price table is configured
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

## Pricing & cost

Pass a price table and every record carries its `cost` in USD. Cost math is pure
and deterministic — the same usage and price always yield the same number, down
to nano-dollar precision so summed spend never drifts:

```ts
import { meteringMiddleware, defaultPrices } from 'abacus';

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: meteringMiddleware({ sink, prices: defaultPrices }),
});

await generateText({ model, prompt: '...' });
console.log(sink.totalCost()); // → total spend in USD across all calls
```

The bundled `defaultPrices` table is **plain, auditable config** in
[`src/pricing/prices.ts`](src/pricing/prices.ts): list prices in USD per 1M
tokens, keyed by model, with a separate (discounted) rate for prompt-cache reads.
Override it with your own negotiated rates by passing any `PriceTable`. Cost math
is also available standalone:

```ts
import { computeCost, defaultPrices } from 'abacus';

computeCost('anthropic/claude-opus-4', record.usage, defaultPrices);
// → { inputCost, cachedInputCost, outputCost, totalCost, currency: 'USD' }
```

Cached input tokens are billed at the cache rate and the remainder at the full
input rate; reasoning tokens are part of output and are not charged twice. A
model with no entry in the table is metered **without** a cost (and surfaced via
an `onUnpricedModel` hook) rather than silently billed at `0`.

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
