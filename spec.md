# abacus — Implementation & Status Plan

**Stack:** Node / TypeScript. Vercel AI SDK 6 middleware, AI Gateway, Langfuse or Helicone, Redis.
**One-liner:** A cost-governance layer for LLM calls: it meters and attributes every token, enforces per-tenant budgets, and degrades gracefully when a budget tightens instead of silently overspending.
**The single concern it isolates:** Costings. Treating spend as a first-class runtime constraint with a policy engine, not a surprise on the monthly invoice.

---

## Why this (the showcase)

This is the concern most AI demos ignore entirely, which is exactly why building it well signals production maturity. The architectural decision on show is a **policy engine that sits in the model-call path** and can meter, attribute, cap, and downshift, all observable.

- Implemented as **AI SDK middleware**, so it wraps any model call without the caller knowing.
- Attribution by tenant / feature / user, with per-dimension budgets.
- Graceful degradation: when a budget is near its limit, downshift the model (for example Opus to Haiku via the Gateway), serve a cache hit, or refuse with a clear error, by policy.
- Spend traces to Langfuse or Helicone; live budget state in Redis.

---

## Scope

**In:**
- Middleware that records tokens, latency, and computed cost per call, tagged with attribution dimensions.
- A budget store (Redis): soft and hard limits per tenant/feature, windowed (daily/monthly).
- A policy engine: on soft-limit, downshift or cache; on hard-limit, refuse; all configurable.
- A model price table kept in config (or read from the Gateway) so cost math is auditable.
- A small dashboard or `/usage` endpoint showing spend by dimension.

**Explicitly out (for v1):**
- Billing/invoicing or payments (it governs spend; it does not charge for it).
- Being a full FinOps platform; keep it a focused layer.

---

## Architecture

```
abacus/
  src/
    middleware/      # AI SDK middleware: meter + enforce
    budget/          # Redis-backed soft/hard limits, windows
    policy/          # downshift / cache / refuse decisions
    pricing/         # auditable price table + cost math
    attribution/     # tenant/feature/user tagging
    usage/           # /usage endpoint + spend rollups
  examples/          # wrapping a sample agent call
```

Design rule: the policy decision is pure and testable, taking (budget state, request) and returning an action (allow / downshift-to-X / cache / refuse). The middleware just executes that action. Cost math is deterministic and unit-tested against the price table.

> **Observability via `watchtower`:** `abacus` does not build its own tracing. It emits spend and metering as OpenTelemetry `gen_ai.*` spans/metrics through `watchtower`, and the price table here is the same one `watchtower` uses to derive cost. `abacus` owns *enforcement* (capping spend); `watchtower` owns *observation* (recording it). Keep that split: the metering middleware records, the policy engine decides, and neither reimplements telemetry.

---

## Best-in-class quality checklist

- [ ] Cost math is deterministic and unit-tested per model in the price table.
- [ ] Attribution verified end to end: a tagged call shows up under the right tenant/feature.
- [ ] Budget enforcement tested under concurrency (no overspend race).
- [ ] Each policy branch (downshift / cache / refuse) tested in isolation.
- [ ] Spend traces visible in Langfuse or Helicone.
- [ ] `/usage` returns accurate rollups; a dashboard screenshot in the README.
- [ ] Wrapping a call requires one line; the README shows before/after.

---

## Milestones & status

| # | Milestone | Outcome | Status |
|---|-----------|---------|--------|
| M0 | Scaffold | TS project, sample wrapped call, CI green | ☐ Not started |
| M1 | Metering | middleware records tokens/latency/cost, attribution tags | ☐ Not started |
| M2 | Pricing | auditable price table, deterministic cost math, tests | ☐ Not started |
| M3 | Budgets | Redis soft/hard limits, windows, concurrency-safe | ☐ Not started |
| M4 | Policy engine | downshift / cache / refuse, per-branch tests | ☐ Not started |
| M5 | Observability | Langfuse/Helicone traces, /usage rollups | ☐ Not started |
| M6 | Dashboard + ship | spend-by-dimension view, README, release | ☐ Not started |

Status legend: ☐ Not started, ◐ In progress, ☑ Done, ⊘ Blocked.

---

## Definition of done

1. A wrapped call is metered and attributed with one line of integration.
2. Crossing a soft limit downshifts (or caches) per policy; crossing a hard limit refuses cleanly.
3. Budget accounting is correct under concurrent calls (tested).
4. Spend by tenant/feature is visible via `/usage` and in the tracing tool.

## Stretch goals
- Forecast month-end spend from the current burn rate.
- Per-tenant rate limiting alongside cost limits.
- A "shadow" mode that reports what a policy *would* do without enforcing it.
