# How-to guides

Task-oriented recipes: each answers one "how do I…" question with the smallest
code that does the job. They assume you have a wrapped model and a ledger to hand
— if you don't, the [integration guide](integration.md) is the linear walkthrough
that stands the whole system up, and the [API reference](api.md) has the exact
HTTP request/response shapes. The [architecture dossier](architecture.md) explains
*why* the pieces split the way they do.

All recipes import from the package root and use a gateway-style model
(`gateway('anthropic/claude-opus-4')`) — substitute your own provider.

- [Measure spend before you enforce anything](#measure-spend-before-you-enforce-anything)
- [Cap a tenant's monthly spend](#cap-a-tenants-monthly-spend)
- [Downshift Opus → Haiku on a soft limit](#downshift-opus--haiku-on-a-soft-limit)
- [Cap a feature's daily spend alongside a tenant's monthly spend](#cap-a-features-daily-spend-alongside-a-tenants-monthly-spend)
- [Serve a cached response instead of spending](#serve-a-cached-response-instead-of-spending)
- [Ship spend to your tracing tool](#ship-spend-to-your-tracing-tool)
- [Fail closed instead of fail open](#fail-closed-instead-of-fail-open)
- [Use your own negotiated prices](#use-your-own-negotiated-prices)
- [Report spend for last month without HTTP](#report-spend-for-last-month-without-http)

---

## Measure spend before you enforce anything

**Goal:** know what every tenant is spending — without changing any behaviour yet.
This is the recommended first step: governance you can't measure, you can't tune.

```ts
import { wrapLanguageModel, generateText } from 'ai';
import { meteringMiddleware, InMemoryMeterSink, defaultPrices } from 'abacus';

const sink = new InMemoryMeterSink();

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: meteringMiddleware({ sink, prices: defaultPrices }),
});

// Callers tag who each call is for; nothing else changes.
await generateText({
  model,
  prompt: '…',
  providerOptions: { abacus: { tenant: 'acme', feature: 'chat' } },
});

sink.rollup('tenant'); // → spend per tenant, priciest first
sink.totalCost();      // → total USD across all calls
```

Metering is pure observation: no budgets, no policy, no behaviour change. When you
know the shape of your spend, layer enforcement on top with the same wrapped model.

> Only `meteringMiddleware` is in the path here — see
> [Step 1](integration.md#step-1--meter-a-model-the-one-line-wrap) of the
> integration guide.

---

## Cap a tenant's monthly spend

**Goal:** stop tenant `acme` from spending more than \$100 in a calendar month;
warn at \$80.

```ts
import { wrapLanguageModel, generateText } from 'ai';
import {
  enforcementMiddleware,
  meteringMiddleware,
  BudgetLedger,
  InMemoryBudgetStore,
  InMemoryMeterSink,
  BudgetExceededError,
  defaultPrices,
  type Policy,
} from 'abacus';

const sink = new InMemoryMeterSink();
const ledger = new BudgetLedger({
  store: new InMemoryBudgetStore(), // RedisBudgetStore in multi-process prod
  budgets: [
    { dimension: 'tenant', key: 'acme', window: 'monthly', soft: 80, hard: 100 },
  ],
});

// Observe at soft (the default), refuse at hard (the default) — so a bare policy
// already caps the tenant. Spelled out here for clarity:
const policy: Policy = { soft: { kind: 'allow' }, hard: { kind: 'refuse' } };

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: [
    enforcementMiddleware({ ledger, policy, prices: defaultPrices }),
    meteringMiddleware({ sink, prices: defaultPrices }),
  ],
});

try {
  await generateText({
    model,
    prompt: '…',
    providerOptions: { abacus: { tenant: 'acme' } },
  });
} catch (err) {
  if (err instanceof BudgetExceededError) {
    // acme has crossed $100 this month — err.trigger names the budget and spend.
    return new Response('Monthly budget exhausted', { status: 429 });
  }
  throw err;
}
```

The budget resets at the UTC month boundary on its own — no cron. The `soft` limit
does nothing here (its rule is `allow`); it becomes useful the moment you want to
*degrade* before the hard stop — see the next recipe.

> `enforcementMiddleware`'s defaults already encode *observe at soft, refuse at
> hard*, so `policy: {}` would behave identically. Make the rules explicit when you
> want them to be auditable in code review.

---

## Downshift Opus → Haiku on a soft limit

**Goal:** when a tenant nears its budget, transparently serve a cheaper model
instead of the expensive one — and only refuse once it's truly exhausted.

```ts
import { wrapLanguageModel } from 'ai';
import {
  enforcementMiddleware,
  meteringMiddleware,
  defaultPrices,
  type Policy,
} from 'abacus';

const policy: Policy = {
  // At soft: rewrite Opus → Haiku. At hard: refuse.
  soft: {
    kind: 'downshift',
    to: { 'anthropic/claude-opus-4': 'anthropic/claude-haiku-4' },
  },
  hard: { kind: 'refuse' },
};

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: [
    enforcementMiddleware({
      ledger,
      policy,
      prices: defaultPrices,
      // The seam a downshift needs to actually CALL a different model.
      resolveModel: (id) => gateway(id),
    }),
    meteringMiddleware({ sink, prices: defaultPrices }),
  ],
});
```

Two details make the downshift real:

- **`resolveModel` is required for it to execute.** `wrapLanguageModel` binds one
  model; a downshift must call another. `resolveModel` turns the target id the
  engine picked into a runnable model. Omit it (or return `undefined`) and the call
  falls back to the requested model rather than failing.
- **The downshift accrues the cheaper rate.** Cost is charged from the *executed*
  model, so once `acme` is downshifted its Haiku calls bill at Haiku's price — the
  budget tightens more slowly, exactly as intended.

The `to` target has three auditable forms: a **string** (always downshift to this
one model), a **record** (`{ requested → replacement }`, above), or a **function**
(`(modelId) => string | undefined`). If no target resolves for the requested
model, the rule falls through to its `else` (default `allow`).

---

## Cap a feature's daily spend alongside a tenant's monthly spend

**Goal:** `acme` gets \$100/month overall, *and* the `chat` feature gets \$5/day —
whichever bites first wins.

```ts
const ledger = new BudgetLedger({
  store,
  budgets: [
    { dimension: 'tenant',  key: 'acme', window: 'monthly', soft: 80, hard: 100 },
    { dimension: 'feature', key: 'chat', window: 'daily',   hard: 5 },
  ],
});

await generateText({
  model,
  prompt: '…',
  providerOptions: { abacus: { tenant: 'acme', feature: 'chat' } },
});
```

A single call falls under **every** budget its attribution matches — here both the
tenant-monthly and the feature-daily budget. The **most severe** level governs
(`hard` beats `soft`, ties broken by the fraction of the limit consumed), so if
`chat` blows its daily \$5 the call refuses even though `acme` still has monthly
headroom. Budgets with different windows coexist freely on the same call.

> Budgets key only on `tenant` / `feature` / `user`. Free-form `tags` are recorded
> and can be rolled up, but can't carry a budget.

---

## Serve a cached response instead of spending

**Goal:** at the soft limit, return a cached answer when you have one rather than
spending — and fall through to the live call on a miss.

```ts
import type { GovernanceCache } from 'abacus';

const cache: GovernanceCache = {
  async lookupGenerate(params) {
    const hit = await myCache.get(keyFor(params));
    return hit; // a LanguageModelV3GenerateResult, or undefined to fall through
  },
  // lookupStream is the streaming analogue; both are optional.
};

const policy: Policy = {
  soft: { kind: 'cache' }, // try cache first as the budget tightens
  hard: { kind: 'refuse' },
};

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: [
    enforcementMiddleware({ ledger, policy, prices: defaultPrices, cache }),
    meteringMiddleware({ sink, prices: defaultPrices }),
  ],
});
```

abacus does **not** own a cache — `GovernanceCache` is the hook where yours plugs
in. A `cache` decision serves a hit if you return one; a miss (`undefined`) falls
through to the live call, which is still metered and charged. Provide
`lookupGenerate`, `lookupStream`, or both depending on which paths you cache.

---

## Ship spend to your tracing tool

**Goal:** spend shows up in your existing OpenTelemetry/`gen_ai.*` dashboards
alongside every other instrumented LLM call — no bespoke pipeline.

```ts
import { trace, metrics } from '@opentelemetry/api';
import { wrapLanguageModel } from 'ai';
import { meteringMiddleware, otelMeterSink, defaultPrices } from 'abacus';

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: meteringMiddleware({
    sink: otelMeterSink({
      tracer: trace.getTracer('abacus'),
      meter: metrics.getMeter('abacus'),
    }),
    prices: defaultPrices, // so spans and metrics carry cost
  }),
});
```

`otelMeterSink` is just a `MeterSink`, so it drops into the metering path with no
new wiring. Each call emits a back-dated `gen_ai.*` span plus the GenAI metrics
(`gen_ai.client.token.usage` / `gen_ai.client.operation.duration` histograms and
an `abacus.cost.usd` counter attributed by tenant/feature/user — the
spend-by-dimension view in your metrics backend).

abacus has **no runtime OpenTelemetry dependency**: the sink targets a structural
`OTelTracerLike` / `OTelMeterLike` seam that a real OTel `Tracer` / `Meter`
satisfies as-is. Provide a `tracer`, a `meter`, or both. Per the spec, abacus
*enforces* spend and *observes* through [`watchtower`](../spec.md) — it does not
reinvent tracing.

> Pair this with `enforcementMiddleware` to enforce **and** observe on the same
> wrapped model; the sink only handles observation.

---

## Fail closed instead of fail open

**Goal:** your risk posture says a budget-store outage (or a downshift that can't
resolve) must **block** the call, not let it through.

By default abacus **fails open** — if the ledger throws while reading or charging,
the call proceeds, because a store outage should degrade governance, not take down
every LLM call. To fail closed, you have two seams:

**1. A store outage** — wrap the ledger so a read failure throws instead of being
swallowed, or convert the routed error in `onError`:

```ts
enforcementMiddleware({
  ledger,
  policy,
  prices: defaultPrices,
  onError(err, ctx) {
    // ctx.phase is 'check' (pre-call read) or 'charge' (post-call write).
    // Re-throw on a failed read to refuse rather than proceed.
    if (ctx.phase === 'check') throw err;
  },
});
```

**2. A downshift with no resolvable target** — set the rule's `else` to `refuse`
so a non-degradable call is blocked rather than allowed through:

```ts
const policy: Policy = {
  soft: {
    kind: 'downshift',
    to: { 'anthropic/claude-opus-4': 'anthropic/claude-haiku-4' },
    else: { kind: 'refuse' }, // no cheaper model? refuse, don't allow
  },
  hard: { kind: 'refuse' },
};
```

Fail-open is the safe default for availability; fail-closed is opt-in for spend
control that must never leak. Pick per call path.

---

## Use your own negotiated prices

**Goal:** bill against your contracted rates, not public list prices.

A `PriceTable` is plain config: `Record<modelId, ModelPrice>`, in **USD per 1M
tokens**. Pass your own anywhere `defaultPrices` is accepted.

```ts
import type { PriceTable } from 'abacus';

const myPrices: PriceTable = {
  'claude-opus-4':  { input: 12, output: 60, cachedInput: 1.2 },
  'claude-haiku-4': { input: 0.7, output: 3.5, cachedInput: 0.07 },
};

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-opus-4'),
  middleware: meteringMiddleware({ sink, prices: myPrices }),
});
```

The table is conventionally keyed by **bare** model id (`claude-opus-4`); lookups
match an exact id first, then fall back to the bare id after the last `/`, so a
gateway-style `anthropic/claude-opus-4` prices correctly. `cachedInput` is the
discounted prompt-cache read rate — omit it and cache reads bill at the full
`input` rate. A model with no entry is metered **without** a cost and surfaced via
`onUnpricedModel`, never silently billed at `0`.

Start from `defaultPrices` and spread your overrides on top if you only adjust a
few models:

```ts
import { defaultPrices } from 'abacus';
const prices: PriceTable = { ...defaultPrices, 'claude-opus-4': { input: 12, output: 60 } };
```

---

## Report spend for last month without HTTP

**Goal:** generate a spend-by-dimension report for a scheduled email or a finance
export — no endpoint, no server.

`buildUsageReport` is the pure core the `/usage` endpoint and the dashboard are
both built on. Call it directly over any array of records:

```ts
import { buildUsageReport } from 'abacus';

const since = Date.UTC(2026, 5, 1); // 2026-06-01, inclusive
const until = Date.UTC(2026, 6, 1); // 2026-07-01, exclusive

const report = buildUsageReport(sink.records, {
  since,
  until,
  dimensions: ['tenant', 'feature'], // omit for all three
});

report.totals;       // { count, usage, cost } across the window
report.byDimension;  // { tenant: [...], feature: [...] } — each cost-sorted
```

The window is `[since, until)` — `since` inclusive, `until` exclusive — so adjacent
months partition records with no double-counting. `report` is a plain object: feed
`report.byDimension.tenant` straight into an email template, a CSV, or a Slack
message. To render it as the same HTML the dashboard serves, pass it to
`renderUsageDashboard(report)`.

> For the HTTP versions of this view (JSON and the HTML dashboard) see
> [Steps 7–8](integration.md#step-7--expose-usage-json) of the integration guide
> and the [API reference](api.md).

---

## See also

- [Integration guide](integration.md) — the linear, stand-it-all-up walkthrough.
- [API reference](api.md) — the `/usage` and dashboard HTTP surface in detail.
- [Architecture dossier](architecture.md) — how the pieces fit and why.
- [`examples/wrap-call.ts`](../examples/wrap-call.ts) — every surface wired against
  a mock model, runnable offline with `npm run example`.
