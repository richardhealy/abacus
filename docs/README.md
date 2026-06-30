# abacus documentation

A cost-governance layer for LLM calls — it meters and attributes every token,
enforces per-tenant budgets, and degrades gracefully (downshift / cache / refuse)
instead of silently overspending. Built as [Vercel AI SDK](https://ai-sdk.dev)
middleware, so it wraps any model call without the caller knowing.

New here? Start with the [project README](../README.md) for the one-line wrap and
the headline ideas, then come back for depth.

## Guides

| Document | Read it to… |
|---|---|
| **[Integration guide](integration.md)** | Stand abacus up in a real app, end to end — wire the middleware, choose a sink and a store, define budgets and a policy, and mount `/usage` and the dashboard. The linear walkthrough. |
| **[How-to guides](how-to.md)** | Solve one specific task fast — cap a tenant's monthly spend, downshift Opus → Haiku on a soft limit, ship spend to your tracing tool, report spend without HTTP, and more. Task-oriented recipes. |
| **[API reference](api.md)** | Look up the exact HTTP surface — the `/usage` (JSON) and dashboard (HTML) handlers: mounting, the record source, query params, response shapes, and error cases. Plus how to generate the TypeDoc library reference. |
| **[Architecture dossier](architecture.md)** | Understand *how* and *why* — the observe-vs-enforce split, the component and data-flow maps, the structural seams, the design trade-offs, and where each part of the spec lives in the code. |

## Reference

- **Library API (TypeDoc).** Generate the type-level reference for the whole
  exported surface from the source doc comments:

  ```bash
  npm run docs:api   # → docs/api/ (gitignored; reproducible from the comments)
  ```

  Open `docs/api/index.html`. It is regenerated from the doc comments, so it never
  drifts from the code.

- **[`spec.md`](../spec.md)** — the target system, its stack, and its scope.
- **[`PROGRESS.md`](../PROGRESS.md)** — the milestone and documentation checklist,
  plus the design notes and decisions behind each increment.
- **[`CHANGELOG.md`](../CHANGELOG.md)** — what changed, when.

## Run it

```bash
npm install
npm run example   # wires every surface against a mock model — no API keys
npm run check     # lint + typecheck + test + build
```

[`examples/wrap-call.ts`](../examples/wrap-call.ts) wires metering, pricing,
attribution, enforcement (allow / downshift / refuse), `/usage`, and the dashboard
end-to-end, offline. For a snapshot of that path running in the terminal — the
metering table, the spend-by-tenant bars, and the allow / downshift / refuse
decisions — see [`governance.png`](governance.png) (also embedded in the
[project README](../README.md#enforcement)); the spend-by-dimension HTML dashboard
is captured in [`dashboard.png`](dashboard.png).

## Where to start by goal

- *"I just want to see what we're spending."* →
  [Measure spend before you enforce anything](how-to.md#measure-spend-before-you-enforce-anything).
- *"I want a hard cap per tenant."* →
  [Cap a tenant's monthly spend](how-to.md#cap-a-tenants-monthly-spend).
- *"I want to spend less, not just refuse."* →
  [Downshift Opus → Haiku on a soft limit](how-to.md#downshift-opus--haiku-on-a-soft-limit).
- *"I want spend in my dashboards."* →
  [Ship spend to your tracing tool](how-to.md#ship-spend-to-your-tracing-tool)
  or expose [`/usage`](integration.md#step-7--expose-usage-json).
- *"I want to understand the design before I commit."* →
  [Architecture dossier](architecture.md).
