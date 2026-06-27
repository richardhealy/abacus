# API reference

abacus exposes two surfaces:

1. **A TypeScript library** — the middlewares, stores, sinks, the policy engine,
   and the pure helpers behind them. Imported from the `abacus` package.
2. **An HTTP surface** — two framework-agnostic [Web Fetch][fetch] handlers that
   serve the spend-by-dimension view: `usageHandler` (JSON) and
   `dashboardHandler` (HTML).

This document is the reference for both. For task-oriented walkthroughs see the
[integration guide](./integration.md) (once written); for the design see the
[architecture dossier](./architecture.md) (once written).

[fetch]: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API

---

## Library API (TypeDoc)

The full symbol-level reference — every exported function, type, interface, and
constant, with the TSDoc comments rendered — is generated from the source by
[TypeDoc](https://typedoc.org):

```sh
npm run docs:api      # writes HTML to docs/api/ ; open docs/api/index.html
```

The generated output (`docs/api/`) is **not** checked in — it is reproducible
from the doc comments at any commit. The single entry point is
[`src/index.ts`](../src/index.ts), which re-exports the public surface of every
module; anything not re-exported there is internal and may change without notice.

The exported surface, grouped by module:

| Module | Key exports |
| --- | --- |
| **Metering** | `meteringMiddleware`, `InMemoryMeterSink`, `normalizeUsage`; types `MeterRecord`, `MeterSink`, `TokenUsage`, `MeteringOptions` |
| **Enforcement** | `enforcementMiddleware`, `BudgetExceededError`; types `EnforcementOptions`, `GovernanceCache`, `ModelResolver` |
| **Pricing** | `costOf`, `priceFor`, `computeCost`, `defaultPrices`; types `ModelPrice`, `PriceTable`, `CostBreakdown` |
| **Attribution** | `rollupByDimension`, `attributionFromProviderOptions`, `mergeAttribution`, `ATTRIBUTION_DIMENSIONS`, `ATTRIBUTION_PROVIDER_KEY`, `UNATTRIBUTED_KEY`; types `Attribution`, `AttributionDimension`, `RollupEntry` |
| **Budgets** | `InMemoryBudgetStore`, `RedisBudgetStore`, `BudgetLedger`, `windowKey`, `evaluateBudget`; types `Budget`, `BudgetState`, `BudgetStore`, `RedisLike` |
| **Policy** | `decide`, `mostSevere`, `resolveDownshift`, `describeBudgetState`; types `Policy`, `PolicyRule`, `PolicyAction`, `Downshift` |
| **Observability** | `otelMeterSink`, `genAiSpanAttributes`, `genAiMetricAttributes`; types `OTelTracerLike`, `OTelMeterLike` |
| **Usage / dashboard** | `buildUsageReport`, `usageHandler`, `renderUsageDashboard`, `dashboardHandler`; types `UsageReport`, `UsageHandlerOptions`, `UsageRecordSource` |

The two middlewares — `meteringMiddleware` to **observe** and
`enforcementMiddleware` to **enforce** — are the integration points; everything
else is the seams and pure helpers they are built from. See the
[README](../README.md) for runnable wiring examples.

---

## HTTP API

abacus does not run a server. It ships two **handlers** — functions of the shape
`(request: Request) => Promise<Response>`, the [Web Fetch][fetch] standard — that
you mount on a route in whatever runtime you already use. Both compute over the
same metered records and never throw: every failure becomes an HTTP status.

| Endpoint | Handler | Method | Success body |
| --- | --- | --- | --- |
| Usage (JSON) | `usageHandler` | `GET`, `HEAD` | `application/json` — a [`UsageReport`](#usagereport) |
| Dashboard (HTML) | `dashboardHandler` | `GET`, `HEAD` | `text/html` — a self-contained page |

There is **no fixed path**: you choose the route when you mount the handler
(`/usage` and `/dashboard` are the conventional choices). Both handlers accept
the same three query parameters and return the same status codes; they differ
only in how they render the report.

### Mounting

Both handlers drop into any Web-standard runtime in one line:

```ts
import { usageHandler, dashboardHandler } from 'abacus';

const source = () => sink.records; // see "The record source" below

// Next.js App Router — app/usage/route.ts, app/dashboard/route.ts:
export const GET = usageHandler({ source });
export const GET = dashboardHandler({ source });

// Hono:
app.get('/usage', (c) => usageHandler({ source })(c.req.raw));
app.get('/dashboard', (c) => dashboardHandler({ source })(c.req.raw));

// Bun:  Bun.serve({ fetch: usageHandler({ source }) });
// Deno: Deno.serve(usageHandler({ source }));
// Cloudflare Workers: export default { fetch: usageHandler({ source }) };
```

### The record source

Both handlers read the metered records they report over through a
**`UsageRecordSource`** — `() => MeterRecord[] | Promise<MeterRecord[]>`. This is
the read-side seam, the analogue of `MeterSink` on the write side:

- In-memory sink (single process): `source: () => sink.records`.
- Durable store (Redis, a warehouse): return a promise that fetches the rows,
  e.g. `source: async () => await db.recentMeterRecords()`.

If the source throws (or rejects), the handler returns `500` — it never lets the
exception reach the runtime.

### Authentication

The handlers carry **no built-in authentication or authorization** — they expose
spend data, so you must place them behind your own access control. They are plain
`(Request) => Response` functions, so wrap them with whatever your stack already
uses:

```ts
const usage = usageHandler({ source });

export const GET = async (request: Request): Promise<Response> => {
  if (!isAuthorized(request)) return new Response('Unauthorized', { status: 401 });
  return usage(request);
};
```

Because the source is a function you supply, you can also scope the data per
caller — e.g. return only one tenant's records for a tenant-scoped token.

### Query parameters

All three are optional and shared by both endpoints. They are parsed identically
(by the shared `usageReportOptionsFromQuery`), so the JSON and HTML views can
never disagree.

| Parameter | Repeatable | Meaning | Default |
| --- | --- | --- | --- |
| `dimension` | yes | Which attribution dimension(s) to roll up by | all of `tenant`, `feature`, `user` |
| `since` | no | Inclusive lower bound on a record's timestamp, **epoch ms** | unbounded |
| `until` | no | Exclusive upper bound on a record's timestamp, **epoch ms** | unbounded |

- **`dimension`** accepts only `tenant`, `feature`, or `user`. Supply it
  repeated (`?dimension=tenant&dimension=feature`) or comma-separated
  (`?dimension=tenant,feature`); values are de-duplicated. Any other value is a
  `400`.
- **`since` / `until`** window the report to a `[since, until)` range — `since`
  inclusive, `until` exclusive — so adjacent windows partition spend without
  double-counting. A non-numeric value is a `400`. The echoed `window` in the
  response uses `null` for an omitted bound.

Examples:

```
GET /usage
GET /usage?dimension=tenant
GET /usage?dimension=tenant,feature
GET /usage?since=1719446400000&until=1719532800000
GET /dashboard?dimension=tenant&since=1719446400000
```

---

### `GET /usage` — spend report (JSON)

Served by `usageHandler({ source, dimensions?, unattributedKey? })`. Returns the
spend-by-dimension [`UsageReport`](#usagereport) as JSON.

`200 OK`, `content-type: application/json; charset=utf-8`:

```jsonc
{
  "window": { "since": null, "until": null },
  "totals": {
    "count": 3,
    "usage": {
      "inputTokens": 4200,
      "outputTokens": 1300,
      "totalTokens": 5500,
      "cachedInputTokens": 0,
      "reasoningTokens": 0
    },
    "cost": 0.0037
  },
  "byDimension": {
    "tenant": [
      {
        "key": "acme",
        "count": 1,
        "usage": {
          "inputTokens": 3000,
          "outputTokens": 900,
          "totalTokens": 3900,
          "cachedInputTokens": 0,
          "reasoningTokens": 0
        },
        "cost": 0.0029
      },
      {
        "key": "globex",
        "count": 2,
        "usage": {
          "inputTokens": 1200,
          "outputTokens": 400,
          "totalTokens": 1600,
          "cachedInputTokens": 0,
          "reasoningTokens": 0
        },
        "cost": 0.0008
      }
    ],
    "feature": [ /* … same RollupEntry shape … */ ],
    "user": [ /* … */ ]
  }
}
```

Notes on the shape:

- `byDimension` contains **only the dimensions requested** (all three by
  default). Each list is sorted by `cost` descending, then `key` ascending, so
  the priciest leads and the order is deterministic.
- Records carrying no value on a dimension are collected under the
  `unattributedKey` (default `"(unattributed)"`), never dropped — every record
  is accounted for.
- `cost` is in **US dollars**, rounded to nano-dollar precision. Calls metered
  without a price table contribute `0`.

The pure core, `buildUsageReport(records, options)`, is exported so you can build
the exact same report without HTTP (a cron job, an email, a test).

---

### `GET /dashboard` — spend dashboard (HTML)

Served by `dashboardHandler({ source, dimensions?, unattributedKey?, title? })`.
Renders the **same** report as a self-contained HTML page — headline totals
(spend, calls, tokens) above one table per dimension, each row showing its calls,
tokens, cost, and a bar for its share of total spend.

`200 OK`, `content-type: text/html; charset=utf-8`. The page is server-rendered
with inline styles only — no client JavaScript, no external assets — and every
dynamic value is HTML-escaped, so an attacker-controlled tenant id cannot inject
markup. The optional `title` option sets the page `<title>` and header (default
`"abacus — spend by dimension"`).

The pure renderer, `renderUsageDashboard(report, { title? })`, is exported for
rendering outside HTTP — a static snapshot, a screenshot, an email. (The README's
dashboard screenshot is produced this way.)

---

### Error responses

Both handlers are hardened identically — they **never throw**. Every failure maps
to a status code, returned as JSON from `usageHandler` and as a small HTML error
page from `dashboardHandler`.

| Status | When | JSON body (`usageHandler`) | Extra |
| --- | --- | --- | --- |
| `400 Bad Request` | Unknown `dimension`, or non-numeric `since` / `until` | `{ "error": "unknown dimension \"…\"; expected one of tenant, feature, user" }` | — |
| `405 Method Not Allowed` | Any method other than `GET` / `HEAD` | `{ "error": "method POST not allowed" }` | `Allow: GET, HEAD` header |
| `500 Internal Server Error` | The `source` threw or rejected | `{ "error": "usage source failed: <message>" }` | — |

`dashboardHandler` returns the same statuses with the same triggers, rendered as
HTML (`Bad request`, `Method not allowed`, `Usage source failed`) rather than
JSON, and likewise sets `Allow: GET, HEAD` on a `405`.

---

## Type reference

The shapes returned by the HTTP surface. Full per-field docs are in the
[TypeDoc output](#library-api-typedoc); the essentials:

### `UsageReport`

```ts
interface UsageReport {
  window: UsageWindow;                                   // the window covered (echoes the request bounds)
  totals: UsageTotals;                                   // grand totals across the window
  byDimension: Partial<Record<AttributionDimension, RollupEntry[]>>;
}

interface UsageWindow {
  since: number | null;  // inclusive lower bound (epoch ms), or null
  until: number | null;  // exclusive upper bound (epoch ms), or null
}

interface UsageTotals {
  count: number;       // number of metered calls
  usage: TokenUsage;   // summed token usage
  cost: number;        // summed cost in USD (nano-dollar rounded)
}
```

### `RollupEntry`

```ts
interface RollupEntry {
  key: string;         // the dimension value (a tenant id, …) or "(unattributed)"
  count: number;       // calls attributed to this key
  usage: TokenUsage;   // summed token usage
  cost: number;        // summed cost in USD (nano-dollar rounded)
}
```

### `TokenUsage`

```ts
interface TokenUsage {
  inputTokens: number;        // prompt tokens (includes cached)
  outputTokens: number;       // completion tokens (includes reasoning)
  totalTokens: number;        // input + output
  cachedInputTokens: number;  // prompt tokens served from cache
  reasoningTokens: number;    // output tokens spent on reasoning
}
```

Every field defaults to `0` when the provider does not report it, so cost math
never has to guard for `undefined`.
