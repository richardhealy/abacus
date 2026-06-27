# abacus

A **cost-governance layer for LLM calls.** It meters and attributes every token,
enforces per-tenant budgets, and degrades gracefully when a budget tightens —
instead of silently overspending and finding out on the monthly invoice.

The architectural idea on show is a **policy engine that sits in the model-call
path** and can meter, attribute, cap, and downshift — all observable. It is built
as [Vercel AI SDK](https://ai-sdk.dev) middleware, so it wraps any model call
without the caller knowing.

> **Status:** early. Metering (**M0–M1**), pricing (**M2**), and budgets
> (**M3**) are in place — one-line wrapping that meters both the buffered
> (`generateText`) and streaming (`streamText`) paths, normalized token metering,
> attribution by tenant / feature / user with spend rollups, a pluggable sink, an
> auditable price table, deterministic per-call cost, and concurrency-safe
> soft/hard budgets over daily/monthly windows (in-memory or Redis-backed). The
> policy engine that enforces those budgets and the `/usage` endpoint are next.
> See [`PROGRESS.md`](PROGRESS.md) and [`spec.md`](spec.md).

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

The same wrap meters **streaming** calls too. Parts flow through untouched and
the record is written when the stream drains, reading usage from the terminal
`finish` part — so `streamText` is metered with no change to the streaming code:

```ts
const result = streamText({ model, prompt: 'Tell me about Paris.' });
for await (const delta of result.textStream) process.stdout.write(delta);
// ...one MeterRecord is captured once the stream completes...
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
  modelId: string;            // e.g. "anthropic/claude-opus-4"
  provider: string;           // e.g. "gateway"
  timestamp: number;          // epoch ms when the call completed
  latencyMs: number;          // wall-clock duration of the model call
  usage: TokenUsage;          // normalized, flat token counts (never undefined)
  attribution?: Attribution;  // who the call is for (tenant / feature / user)
  cost?: number;              // computed spend in USD, when a price table is configured
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

## Attribution

Spend is only useful if you know whose it is. Tag a call with the tenant,
feature, and user it serves by passing `providerOptions.abacus` — the same
wrapped model serves everyone, and attribution rides along on the call it
describes:

```ts
await generateText({
  model,
  prompt: '...',
  providerOptions: { abacus: { tenant: 'acme', feature: 'chat', user: 'u_1' } },
});
```

The metered record carries that `attribution`, and the sink rolls spend up by any
dimension — sorted by cost, so the priciest tenant or feature leads:

```ts
sink.rollup('tenant');
// → [ { key: 'acme', count: 12, usage: {…}, cost: 1.84 },
//     { key: 'globex', count: 3, usage: {…}, cost: 0.21 } ]
```

A middleware can also carry a **static default** (e.g. `attribution: { feature:
'chat' }`) when one wrapped model only ever serves one feature; per-call values
merge on top, winning field by field. Calls with no value on a dimension roll up
under `(unattributed)` rather than being dropped. `rollupByDimension` is exported
standalone for building the same view over records from any sink.

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

## Budgets

A **budget** caps spend for one attribution scope over a window — "$10/month for
tenant acme", "$2/day for the chat feature". Each budget carries a **soft** limit
(degrade gracefully) and a **hard** limit (refuse), both in USD:

```ts
import { BudgetLedger, InMemoryBudgetStore } from 'abacus';

const budgets = new BudgetLedger({
  store: new InMemoryBudgetStore(),
  budgets: [
    { dimension: 'tenant', key: 'acme', window: 'monthly', soft: 8, hard: 10 },
    { dimension: 'feature', key: 'chat', window: 'daily', hard: 2 },
  ],
});

// Charge an attributed cost; it lands on every budget the call falls under.
const states = await budgets.charge(
  { tenant: 'acme', feature: 'chat' },
  0.5,
);
// → [ { budget: {…}, spent: 0.5, level: 'ok', fraction: 0.05 }, … ]

// Or read the current state without charging, to decide before a call runs.
await budgets.check({ tenant: 'acme' });
```

`charge` returns a `BudgetState` per matching budget — its `spent` so far this
window, the `level` it has crossed (`ok` / `soft` / `hard`), and the `fraction`
of the hard limit consumed. The budget layer only **measures**; deciding what to
do when a level is crossed (downshift / cache / refuse) is the policy engine's
job (next milestone), keeping the decision pure and testable.

Spend lives in a `BudgetStore`. `InMemoryBudgetStore` is provided for tests and
single-process use; `RedisBudgetStore` backs spend with Redis for multi-process
deployments and plugs into the same interface:

```ts
import { RedisBudgetStore } from 'abacus';
import Redis from 'ioredis';

const store = new RedisBudgetStore(new Redis(process.env.REDIS_URL!));
```

**Accounting is concurrency-safe:** spend is added atomically (a synchronous
read-modify-write in memory, server-side `INCRBYFLOAT` in Redis), so simultaneous
calls can never lose an increment — the overspend race. Windows are bucketed in
UTC and Redis keys expire at the window boundary, so spend resets with no cron.
`RedisBudgetStore` is written against a minimal client interface, so abacus adds
no Redis dependency of its own.

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
