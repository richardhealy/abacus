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
- **Prompt caching for agent loops:** the biggest input-token lever in a multi-turn agent is the stable prefix it re-sends every step (system, tool schemas, prior turns). `abacus` plans and maintains `cache_control` breakpoints over that prefix so each step re-reads cached tokens at a fraction of the cost, and the resulting cache reads/writes and savings are metered and attributed like any other spend.
- Spend traces to Langfuse or Helicone; live budget state in Redis.

---

## Scope

**In:**
- Middleware that records tokens, latency, and computed cost per call, tagged with attribution dimensions.
- A budget store (Redis): soft and hard limits per tenant/feature, windowed (daily/monthly).
- A policy engine: on soft-limit, downshift or cache; on hard-limit, refuse; all configurable.
- A model price table kept in config (or read from the Gateway) so cost math is auditable, including per-model cache-read / cache-write pricing.
- Prompt-cache planning for agent loops: place and maintain `cache_control` breakpoints on the stable prefix (system, tools, prior turns), track cache hit rate and input-token savings, and roll them into the usage report.
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
    pricing/         # auditable price table + cost math (incl. cache read/write)
    caching/         # prompt-cache breakpoint planning for agent loops (cache_control)
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
- [ ] Prompt-cache breakpoints cut input-token cost on a multi-turn agent loop, with hit rate and savings measured and attributed.
- [ ] Spend traces visible in Langfuse or Helicone.
- [ ] `/usage` returns accurate rollups; a dashboard screenshot in the README.
- [ ] Wrapping a call requires one line; the README shows before/after.

---

## Milestones & status

| # | Milestone | Outcome | Status |
|---|-----------|---------|--------|
| M0 | Scaffold | TS project, sample wrapped call, CI green | ☑ Done |
| M1 | Metering | middleware records tokens/latency/cost, attribution tags | ☑ Done |
| M2 | Pricing | auditable price table, deterministic cost math, tests | ☑ Done |
| M3 | Budgets | Redis soft/hard limits, windows, concurrency-safe | ☑ Done |
| M4 | Policy engine | downshift / cache / refuse, per-branch tests | ☑ Done |
| M5 | Observability | Langfuse/Helicone traces, /usage rollups | ☑ Done |
| M6 | Dashboard + ship | spend-by-dimension view, README, release | ☑ Done |
| M7 | Prompt caching | cache_control breakpoints for agent loops, hit-rate + savings metered | ☐ Not started |

Status legend: ☐ Not started, ◐ In progress, ☑ Done, ⊘ Blocked.

---

## Definition of done

1. A wrapped call is metered and attributed with one line of integration.
2. Crossing a soft limit downshifts (or caches) per policy; crossing a hard limit refuses cleanly.
3. Budget accounting is correct under concurrent calls (tested).
4. Spend by tenant/feature is visible via `/usage` and in the tracing tool.
5. A multi-turn agent loop shows measured input-token savings from `cache_control` breakpoints, attributed in `/usage`.

## Stretch goals
- Forecast month-end spend from the current burn rate.
- Per-tenant rate limiting alongside cost limits.
- A "shadow" mode that reports what a policy *would* do without enforcing it.
