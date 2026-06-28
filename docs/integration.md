# Integration guide

This guide stands `abacus` up in a real application: wiring the call-path
middleware, choosing a sink and a store, defining budgets and a policy, and
mounting the `/usage` endpoint and dashboard — with concrete, runnable examples
for each surface.

If you want the *why* behind the pieces, read the
[architecture dossier](architecture.md) first; this guide is the *how*. For the
exact request/response shapes of the HTTP surfaces, see the
[API reference](api.md). For the generated type-level reference, run
`npm run docs:api` (TypeDoc).

---

## What you integrate against

abacus has two kinds of integration surface, and you wire them independently:

| Surface | What it is | Where it runs |
|---|---|---|
| **`meteringMiddleware`** | Observes — records tokens, latency, cost per call | In the model-call path (AI SDK middleware) |
| **`enforcementMiddleware`** | Enforces — downshifts / caches / refuses per budget, charges spend | In the model-call path (AI SDK middleware) |
| **`otelMeterSink`** | A `MeterSink` that emits spend as OpenTelemetry `gen_ai.*` telemetry | Behind metering, into your tracer/meter |
| **`usageHandler`** | A Web Fetch handler serving the spend-by-dimension report as JSON | An HTTP route (`/usage`) |
| **`dashboardHandler`** | The HTML twin of `usageHandler` | An HTTP route (a dashboard page) |

The two middlewares are the core; the sink and the two handlers are how spend
becomes visible. You can adopt them incrementally — metering alone is useful on
day one, enforcement and the endpoints layer on later.

---

## Prerequisites

- **Node ≥ 20** (the runtime targets web-standard `Request`/`Response` and
  `TransformStream`, which Node 20 provides).
- The **Vercel AI SDK v6** (`ai`) and `@ai-sdk/provider`. abacus depends only on
  these two — it adds no Redis, OpenTelemetry, or HTTP-framework dependency of its
  own; those are seams you supply.
- A way to **resolve models**. abacus wraps an AI SDK `LanguageModel`. In
  production that is typically a Vercel **AI Gateway** model
  (`gateway('anthropic/claude-opus-4')`) or a provider client. The examples below
  use a gateway-style call; substitute your provider.

### Install

abacus is an ESM TypeScript package. Until it is published to a registry, install
it from the repository (or vendor it into your monorepo):

```bash
# from a published registry (once available)
npm install abacus

# or from git
npm install github:richardhealy/abacus
```

`ai` and `@ai-sdk/provider` are peer-level runtime dependencies — install them in
your app if they are not already present:

```bash
npm install ai @ai-sdk/provider
```

Everything is exported from the package root:

```ts
import {
  meteringMiddleware,
  enforcementMiddleware,
  InMemoryMeterSink,
  InMemoryBudgetStore,
  RedisBudgetStore,
  BudgetLedger,
  defaultPrices,
  usageHandler,
  dashboardHandler,
  otelMeterSink,
  BudgetExceededError,
  type Policy,
} from 'abacus';
```

---

## Step 1 — Meter a model (the one-line wrap)

Metering is the smallest useful integration. Wrap any AI SDK model once; every
call through it is metered, and the code calling `generateText` / `streamText`
does not change.

```ts
import { wrapLanguageModel, generateText } from 'ai';
import { meteringMiddleware, InMemoryMeterSink, defaultPrices } from 'abacus';

const sink = new InMemoryMeterSink();

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: meteringMiddleware({ sink, prices: defaultPrices }),
});

await generateText({ model, prompt: 'What is the capital of France?' });

console.log(sink.totals());    // token totals across all calls
console.log(sink.totalCost()); // summed spend in USD
```

The same wrap meters streaming. Parts flow through untouched; the record is
written when the stream drains, reading usage from the terminal `finish` part —
no buffering is added.

`prices` is optional: omit it and calls are metered without a `cost`. Passing
`defaultPrices` (the bundled, auditable list-price table) makes every record
carry its cost. To use negotiated rates, pass your own `PriceTable` — the same
shape, in USD per 1M tokens. A model with no entry is metered without a cost and
surfaced through `onUnpricedModel` rather than silently billed at `0`.

> **Model-id matching.** The price table is keyed by **bare** model id
> (`claude-opus-4`), while the wrapped model may report a namespaced id
> (`anthropic/claude-opus-4`). `priceFor` matches the exact id first, then falls
> back to the bare id after the last `/`, so gateway-style ids price correctly
> against `defaultPrices`.

---

## Step 2 — Attribute spend (who is it for)

Spend is only governable if you know whose it is. Tag each call with the tenant,
feature, and user it serves via `providerOptions.abacus`. The **same wrapped
model serves everyone** — attribution rides on the call, not the model, so the
one-line integration is preserved:

```ts
await generateText({
  model,
  prompt: '…',
  providerOptions: { abacus: { tenant: 'acme', feature: 'chat', user: 'u_1' } },
});
```

All fields are optional, and you can attach free-form `tags` (e.g.
`{ env: 'prod', region: 'eu' }`) for dimensions beyond the three named ones —
rollups can group on tags, though budgets only key on tenant/feature/user.

If one wrapped model only ever serves one feature, set a **static default** on the
middleware (`attribution: { feature: 'chat' }`); per-call values merge on top,
winning field by field.

Read spend back, rolled up by any dimension (cost-sorted, priciest first):

```ts
sink.rollup('tenant');
// → [ { key: 'acme', count: 12, usage: {…}, cost: 1.84 }, … ]
```

---

## Step 3 — Choose a sink

A **sink** is where metered records go. It is the write seam; pick by deployment.

### In-memory (development, single process, tests)

```ts
import { InMemoryMeterSink } from 'abacus';
const sink = new InMemoryMeterSink();
meteringMiddleware({ sink });
```

`InMemoryMeterSink` keeps records in an array (`sink.records`) and offers
`totals()`, `totalCost()`, `rollup(dimension)`, `count`, and `clear()`. It is the
natural `source` for the `/usage` endpoint in a single-process app.

### OpenTelemetry (production observability)

abacus does **not** build its own tracing — per the spec it *observes through
[`watchtower`](../spec.md)* by emitting standard OpenTelemetry `gen_ai.*`
telemetry. `otelMeterSink` is a `MeterSink`, so it slots into the same metering
path:

```ts
import { trace, metrics } from '@opentelemetry/api';
import { meteringMiddleware, otelMeterSink, defaultPrices } from 'abacus';

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: meteringMiddleware({
    sink: otelMeterSink({
      tracer: trace.getTracer('abacus'),
      meter: metrics.getMeter('abacus'),
    }),
    prices: defaultPrices, // so spans/metrics carry cost
  }),
});
```

Each call emits a back-dated `gen_ai.*` span and the GenAI metrics
(`gen_ai.client.token.usage` / `gen_ai.client.operation.duration` histograms,
plus an `abacus.cost.usd` counter attributed by tenant/feature/user). Provide a
`tracer`, a `meter`, or both. abacus has **no runtime OpenTelemetry dependency**:
the sink is written against a structural `OTelTracerLike` / `OTelMeterLike` seam
that a real OTel `Tracer` / `Meter` satisfies as-is, so installing
`@opentelemetry/api` is your app's choice, not abacus's.

### A durable sink (your warehouse / queue)

Any object with `record(record): void | Promise<void>` is a sink. To persist
spend for the `/usage` endpoint across processes, implement one that writes to
your store:

```ts
import type { MeterSink, MeterRecord } from 'abacus';

const dbSink: MeterSink = {
  async record(r: MeterRecord) {
    await db.insert('meter_records', r);
  },
};
```

> **Sinks never break the call.** A throwing sink routes to the metering
> middleware's `onError` hook (default: log) and the wrapped model call still
> returns. Make production sinks fast or async-batched.

---

## Step 4 — Choose a budget store

A **budget store** holds the running spend per scope/window. It is the durable
counter behind enforcement, and like the sink it is a seam.

### In-memory (single process, tests)

```ts
import { InMemoryBudgetStore } from 'abacus';
const store = new InMemoryBudgetStore();
```

Concurrency-safe by construction (a synchronous read-modify-write, atomic under
Node's event loop). Spend lives only in the process, so use it for a single
instance or tests.

### Redis (multi-process, production)

```ts
import { RedisBudgetStore } from 'abacus';
import Redis from 'ioredis';

const store = new RedisBudgetStore(new Redis(process.env.REDIS_URL!), {
  keyPrefix: process.env.NODE_ENV, // optional: isolate envs on a shared instance
});
```

Spend is incremented with the atomic `INCRBYFLOAT`, so concurrent calls across
many processes never lose an increment (the overspend race). Each window bucket
is given a TTL that lands on the window boundary, so spend resets with **no cron**
and stale buckets clean themselves up.

`RedisBudgetStore` is written against a minimal `RedisLike` interface
(`incrbyfloat` / `expire` / `get`). An `ioredis` client satisfies it directly;
other clients (e.g. `node-redis`) work through a thin adapter. abacus adds no
Redis dependency of its own.

---

## Step 5 — Define budgets and a policy

A **budget** caps spend for one attribution scope over a window. A **policy** says
what to do as a budget tightens.

```ts
import { BudgetLedger, type Policy } from 'abacus';

const ledger = new BudgetLedger({
  store, // from Step 4
  budgets: [
    { dimension: 'tenant',  key: 'acme', window: 'monthly', soft: 8, hard: 10 },
    { dimension: 'feature', key: 'chat', window: 'daily',   hard: 2 },
  ],
});

const policy: Policy = {
  // On soft: downshift Opus → Haiku via the Gateway. On hard: refuse.
  soft: {
    kind: 'downshift',
    to: { 'anthropic/claude-opus-4': 'anthropic/claude-haiku-4' },
  },
  hard: { kind: 'refuse' },
};
```

**Budgets.** Each is keyed on one dimension/value (`tenant: 'acme'`), windowed
`daily` or `monthly`, with an optional `soft` limit and a required `hard` limit in
USD. A single call can fall under several budgets at once (its tenant *and* its
feature); the most severe level governs.

**Policy.** A rule per level. The defaults are conservative — **observe at soft,
refuse at hard** — so degradation is opt-in. A `downshift` rule's `to` target is
auditable in three forms:

- a **string** — always downshift to this one model;
- a **record** — map requested → replacement (shown above), the declarative form;
- a **function** — `(modelId) => string | undefined` to compute the replacement.

When a downshift can't resolve a cheaper model for the requested one, it falls
through to a configurable `else` (default `allow`, so the call proceeds; set
`else: { kind: 'refuse' }` to fail closed). Other rule kinds are `{ kind: 'cache' }`
and `{ kind: 'allow' }`.

> The budget layer only **measures**; the policy engine **decides**; the
> middleware (next step) **executes**. This split keeps the decision pure and
> unit-testable — see the [architecture dossier](architecture.md).

---

## Step 6 — Enforce in the call path

`enforcementMiddleware` reads the budgets a call falls under, runs the policy, and
executes the decision — then charges the executed call's cost back to the ledger.
Compose it alongside metering on the same wrapped model:

```ts
import { wrapLanguageModel, generateText } from 'ai';
import {
  enforcementMiddleware,
  meteringMiddleware,
  BudgetExceededError,
  defaultPrices,
} from 'abacus';

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: [
    // Enforcement is outermost: it decides before metering observes.
    enforcementMiddleware({
      ledger,                              // from Step 5
      policy,                              // from Step 5
      prices: defaultPrices,               // cost charged back to the ledger
      resolveModel: (id) => gateway(id),   // turn a downshift target id into a model
    }),
    meteringMiddleware({ sink, prices: defaultPrices }),
  ],
});

try {
  await generateText({
    model,
    prompt: 'What is the capital of France?',
    providerOptions: { abacus: { tenant: 'acme' } },
  });
  // → allowed, or transparently downshifted to Haiku once acme crosses its soft limit
} catch (err) {
  if (err instanceof BudgetExceededError) {
    // → refused once acme crosses its hard limit; err.trigger names the budget
    return new Response(err.message, { status: 429 });
  }
  throw err;
}
```

Three wiring details that matter in production:

- **`resolveModel` is required for downshift to execute.** `wrapLanguageModel`
  binds one model, but a downshift must call a *different* one. `resolveModel`
  turns the target id the engine picked into a runnable model (a gateway call or a
  `createProviderRegistry` lookup). Omit it, or return `undefined`, and the call
  **falls back to the requested model** rather than failing.
- **`prices` is required** here (unlike metering, where it is optional) — charging
  the ledger is the point, and cost is derived from the *executed* model, so a
  downshift accrues the cheaper rate.
- **`cache`** is an optional `GovernanceCache` hook (`lookupGenerate` /
  `lookupStream`). abacus does not own a cache; a `cache` decision serves a hit if
  you provide one, otherwise falls through to the live call.

**Check-then-charge is deliberately not atomic.** A call's cost is unknown until
it returns, so the decision reads spend *before* the call and the charge updates
it *after* — meaning a crossed limit governs the **next** call. (The store's
`addSpend` is still atomic, so totals never race.)

**Enforcement fails open.** A ledger read or write failure routes to `onError`
and the call proceeds — a store outage degrades governance, it does not take down
every LLM call. If you need fail-closed semantics, wrap the ledger to throw, or
catch in `onError`. Both the buffered and streaming paths are enforced.

---

## Step 7 — Expose `/usage` (JSON)

`usageHandler` serves the spend-by-dimension report as JSON. It is a
framework-agnostic **Web Fetch** handler — `(Request) => Promise<Response>` — so
it mounts in any web-standard runtime in one line and adds no dependency.

```ts
import { usageHandler } from 'abacus';

const usage = usageHandler({ source: () => sink.records });

// GET /usage → the spend-by-dimension UsageReport as JSON
```

The `source` is the read seam between the endpoint and wherever spend lives:

- single-process in-memory sink → `() => sink.records`
- a durable sink → `async () => db.query('SELECT … FROM meter_records')`

Query parameters shape the report (all optional):

- **`dimension`** — restrict the rollups, repeated
  (`?dimension=tenant&dimension=feature`) or comma-separated
  (`?dimension=tenant,feature`). Defaults to all three.
- **`since`** / **`until`** — window to a `[since, until)` range of record
  timestamps (epoch ms); `since` inclusive, `until` exclusive.

The handler never throws: an unknown dimension or non-numeric bound is a `400`, a
non-`GET` a `405`, a failing source a `500`. See the [API reference](api.md) for
the full response shape and error bodies.

The pure core, `buildUsageReport(records, options)`, is exported for building the
same view without HTTP (a scheduled report, an email).

---

## Step 8 — Expose the dashboard (HTML)

`dashboardHandler` is the HTML twin of `usageHandler`: the same Web Fetch shape
over the same `dimension` / `since` / `until` query surface, rendering a
self-contained HTML page instead of JSON.

```ts
import { dashboardHandler } from 'abacus';

const dashboard = dashboardHandler({
  source: () => sink.records,
  title: 'Acme — spend', // optional page title
});

// GET /dashboard → a self-contained HTML page (inline styles, no client JS)
```

The page shows headline totals (spend, calls, tokens) and one table per dimension
with a share bar per row. It is server-rendered and dependency-free, and every
dynamic value is HTML-escaped (an attacker-controlled tenant id cannot inject
markup).

For rendering outside HTTP — a static snapshot, a screenshot, an email — the pure
renderer is exported:

```ts
import { renderUsageDashboard, buildUsageReport } from 'abacus';
import { writeFileSync } from 'node:fs';

const html = renderUsageDashboard(buildUsageReport(sink.records));
writeFileSync('dashboard.html', html);
```

---

## Mounting the HTTP surfaces in your framework

Both handlers are the same `(Request) => Promise<Response>` shape, so they mount
identically. `usage` and `dashboard` below are the handlers from Steps 7–8.

**Next.js App Router** (`app/usage/route.ts`):

```ts
import { usageHandler } from 'abacus';
export const GET = usageHandler({ source: () => sink.records });
```

**Hono:**

```ts
app.get('/usage', (c) => usage(c.req.raw));
app.get('/dashboard', (c) => dashboard(c.req.raw));
```

**Bun:**

```ts
Bun.serve({
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/usage') return usage(req);
    if (pathname === '/dashboard') return dashboard(req);
    return new Response('Not found', { status: 404 });
  },
});
```

**Deno:**

```ts
Deno.serve((req) => {
  const { pathname } = new URL(req.url);
  return pathname === '/dashboard' ? dashboard(req) : usage(req);
});
```

**Cloudflare Workers:**

```ts
export default {
  fetch(req: Request) {
    return new URL(req.url).pathname === '/dashboard' ? dashboard(req) : usage(req);
  },
};
```

**Express** (Node ≥ 20 — adapt the Web `Request`/`Response`):

```ts
app.get('/usage', async (req, res) => {
  const r = await usage(new Request(`http://x${req.originalUrl}`));
  res.status(r.status);
  r.headers.forEach((v, k) => res.setHeader(k, v));
  res.send(await r.text());
});
```

---

## Authentication

abacus ships **no authentication** on the `/usage` endpoint or the dashboard —
spend data is sensitive, so mount them behind your own access control. Place them
on an admin-only route, behind your auth middleware, or gate them in the handler:

```ts
const usage = usageHandler({ source: () => sink.records });

export const GET = (req: Request) => {
  if (!isAdmin(req)) return new Response('Forbidden', { status: 403 });
  return usage(req);
};
```

The call-path middlewares carry no auth of their own either — attribution
(`tenant` / `feature` / `user`) is metadata you supply per call, so derive it
from your *already-authenticated* request context, never from untrusted client
input you have not validated.

---

## A complete, production-shaped wiring

Putting Steps 1–8 together for a multi-process deployment (Redis store, durable
or in-memory sink, both HTTP surfaces):

```ts
import { wrapLanguageModel } from 'ai';
import Redis from 'ioredis';
import {
  meteringMiddleware,
  enforcementMiddleware,
  InMemoryMeterSink,
  RedisBudgetStore,
  BudgetLedger,
  usageHandler,
  dashboardHandler,
  defaultPrices,
  type Policy,
} from 'abacus';

// --- spend storage ---
const sink = new InMemoryMeterSink();            // swap for a durable sink in prod
const store = new RedisBudgetStore(new Redis(process.env.REDIS_URL!));

// --- budgets + policy ---
const ledger = new BudgetLedger({
  store,
  budgets: [
    { dimension: 'tenant', key: 'acme', window: 'monthly', soft: 80, hard: 100 },
  ],
});

const policy: Policy = {
  soft: { kind: 'downshift', to: { 'anthropic/claude-opus-4': 'anthropic/claude-haiku-4' } },
  hard: { kind: 'refuse' },
};

// --- one wrapped model: metered AND governed ---
export const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: [
    enforcementMiddleware({
      ledger,
      policy,
      prices: defaultPrices,
      resolveModel: (id) => gateway(id),
    }),
    meteringMiddleware({ sink, prices: defaultPrices }),
  ],
});

// --- spend visibility ---
export const usage = usageHandler({ source: () => sink.records });
export const dashboard = dashboardHandler({ source: () => sink.records });
```

Callers use `model` exactly as a plain AI SDK model, tagging each call with its
attribution:

```ts
await generateText({
  model,
  prompt: '…',
  providerOptions: { abacus: { tenant: 'acme', feature: 'chat', user: req.userId } },
});
```

---

## Operational notes

- **Adopt incrementally.** Metering with `InMemoryMeterSink` is a useful day-one
  integration on its own. Add pricing, then attribution, then enforcement, then
  the endpoints as you need them — each step is independent.
- **Pin model ids to your price table.** Keep `defaultPrices` (or your override)
  in sync with the models you actually call, and verify the numbers against your
  provider's current rate card — that auditability is the whole point of keeping
  prices as plain config. Watch the `onUnpricedModel` warning for gaps.
- **Pick windows deliberately.** Budgets reset at UTC window boundaries with no
  cron; a `monthly` tenant budget and a `daily` feature budget can coexist on the
  same call.
- **Governance fails open by design.** A sink or ledger outage degrades
  observation/enforcement but never breaks an LLM call. If your risk posture
  requires fail-closed, wrap the ledger to throw and handle it.
- **Run the example.** [`examples/wrap-call.ts`](../examples/wrap-call.ts) wires
  metering, pricing, attribution, enforcement (allow / downshift / refuse across
  three tenants), `/usage`, and the dashboard end-to-end against a mock model —
  no API keys. Run it with `npm run example`.

## See also

- [API reference](api.md) — the HTTP surface in detail (request/response shapes,
  query params, error cases) plus how to generate the TypeDoc library reference.
- [Architecture dossier](architecture.md) — how the pieces fit together, the
  observe-vs-enforce split, the seams, and the design trade-offs.
- [`spec.md`](../spec.md) — the target system and scope.
