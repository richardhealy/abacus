/**
 * The spend dashboard (M6): {@link renderUsageDashboard} renders a {@link
 * UsageReport} as a self-contained HTML page (headline totals plus one table per
 * dimension with share bars), and {@link dashboardHandler} is the HTML twin of
 * {@link usageHandler} over the same query surface. Pure, dependency-free, and
 * HTML-escaped — an attacker-controlled tenant id can't inject markup, and the
 * output drops into any response or a static file.
 *
 * @module
 */
import type { RollupEntry } from '../attribution/rollup.js';
import {
  ATTRIBUTION_DIMENSIONS,
  type AttributionDimension,
} from '../attribution/types.js';
import type { MeterRecord } from '../middleware/types.js';
import { buildUsageReport, type UsageReport, type UsageWindow } from './report.js';
import { isUsageQueryError, usageReportOptionsFromQuery } from './query.js';
import type { UsageRecordSource } from './endpoint.js';

/** Options for {@link renderUsageDashboard}. */
export interface DashboardRenderOptions {
  /** Page `<title>` and header. Defaults to `"abacus — spend by dimension"`. */
  title?: string;
}

const DEFAULT_TITLE = 'abacus — spend by dimension';

const DIMENSION_LABELS: Record<AttributionDimension, string> = {
  tenant: 'Tenant',
  feature: 'Feature',
  user: 'User',
};

/** Escape a string for safe interpolation into HTML text or an attribute value. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a USD amount with sub-cent precision (LLM costs are often fractional). */
function formatUsd(amount: number): string {
  const decimals = amount !== 0 && Math.abs(amount) < 0.0001 ? 8 : 4;
  return `$${amount.toFixed(decimals)}`;
}

/** Format an integer with thousands separators, locale-independently. */
function formatInt(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Format a percentage share (0–1) for display. */
function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Render the covered window as a human-readable line. */
function formatWindow(window: UsageWindow): string {
  const iso = (ms: number): string => new Date(ms).toISOString();
  if (window.since === null && window.until === null) return 'all time';
  if (window.since !== null && window.until !== null) {
    return `${iso(window.since)} → ${iso(window.until)}`;
  }
  if (window.since !== null) return `since ${iso(window.since)}`;
  return `until ${iso(window.until as number)}`;
}

function statCard(label: string, value: string): string {
  return `<div class="card"><div class="card-value">${value}</div><div class="card-label">${escapeHtml(label)}</div></div>`;
}

function row(entry: RollupEntry, totalCost: number): string {
  const share = totalCost > 0 ? entry.cost / totalCost : 0;
  return `<tr>
        <td class="key">${escapeHtml(entry.key)}</td>
        <td class="num">${formatInt(entry.count)}</td>
        <td class="num">${formatInt(entry.usage.totalTokens)}</td>
        <td class="num cost">${formatUsd(entry.cost)}</td>
        <td class="share">
          <div class="share-wrap">
            <div class="bar"><span style="width:${(share * 100).toFixed(2)}%"></span></div>
            <span class="share-pct">${formatPercent(share)}</span>
          </div>
        </td>
      </tr>`;
}

function section(
  dimension: AttributionDimension,
  entries: RollupEntry[],
  totalCost: number,
): string {
  const body =
    entries.length === 0
      ? `<tr><td class="empty" colspan="5">No spend recorded for this dimension.</td></tr>`
      : entries.map((entry) => row(entry, totalCost)).join('\n      ');

  return `<section>
    <h2>${escapeHtml(DIMENSION_LABELS[dimension])}</h2>
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(DIMENSION_LABELS[dimension])}</th>
          <th class="num">Calls</th>
          <th class="num">Tokens</th>
          <th class="num">Cost</th>
          <th class="share">Share</th>
        </tr>
      </thead>
      <tbody>
      ${body}
      </tbody>
    </table>
  </section>`;
}

const STYLES = `
    :root {
      --bg: #f6f7f9;
      --surface: #ffffff;
      --border: #e3e6ea;
      --text: #1b1f24;
      --muted: #6b7280;
      --accent: #4f46e5;
      --accent-soft: #eef0fe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1.25rem 3rem;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    main { max-width: 880px; margin: 0 auto; }
    header { margin-bottom: 1.75rem; }
    h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.01em; }
    .window { color: var(--muted); font-size: 0.85rem; margin-top: 0.25rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin-bottom: 2rem; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.1rem; }
    .card-value { font-size: 1.4rem; font-weight: 650; letter-spacing: -0.02em; }
    .card-label { color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 0.2rem; }
    section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem 1.25rem; margin-bottom: 1.25rem; }
    h2 { margin: 0.25rem 0 0.75rem; font-size: 1.05rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.55rem 0.5rem; text-align: left; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
    tbody tr:last-child td { border-bottom: none; }
    td.key { font-weight: 550; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    td.cost { font-weight: 600; }
    td.empty { color: var(--muted); text-align: center; padding: 1.25rem; }
    th.share, td.share { width: 34%; }
    .share-wrap { display: flex; align-items: center; gap: 0.6rem; }
    .bar { flex: 1; min-width: 90px; height: 8px; background: var(--accent-soft); border-radius: 999px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
    .share-pct { color: var(--muted); font-size: 0.78rem; font-variant-numeric: tabular-nums; min-width: 3.2em; text-align: right; }
    footer { color: var(--muted); font-size: 0.78rem; text-align: center; margin-top: 1.5rem; }
    footer code { background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 0.05rem 0.35rem; }
`;

/**
 * Render the spend-by-dimension {@link UsageReport} as a self-contained HTML page
 * — the M6 dashboard. Pure and deterministic (the same report always yields the
 * same markup), with no external assets, scripts, or dependencies: inline styles
 * only, so it drops into any response or static file.
 *
 * The page shows headline totals (spend, calls, tokens) and one table per
 * dimension in the report, each row carrying its calls, tokens, cost, and a bar
 * showing its share of total spend (rows arrive already sorted by cost from
 * {@link rollupByDimension}). Every dynamic value is HTML-escaped, so an
 * attacker-controlled tenant id cannot inject markup.
 *
 * Serve it over HTTP with {@link dashboardHandler}, or call this directly to
 * snapshot a report to a static file.
 */
export function renderUsageDashboard(
  report: UsageReport,
  options: DashboardRenderOptions = {},
): string {
  const title = options.title ?? DEFAULT_TITLE;
  const { totals } = report;

  const cards = [
    statCard('Total spend', formatUsd(totals.cost)),
    statCard('Calls', formatInt(totals.count)),
    statCard('Total tokens', formatInt(totals.usage.totalTokens)),
    statCard('Input tokens', formatInt(totals.usage.inputTokens)),
    statCard('Output tokens', formatInt(totals.usage.outputTokens)),
  ].join('\n      ');

  // Render dimensions in canonical order, restricted to those the report carries.
  const sections = ATTRIBUTION_DIMENSIONS.filter(
    (dimension) => report.byDimension[dimension] !== undefined,
  )
    .map((dimension) =>
      section(dimension, report.byDimension[dimension] ?? [], totals.cost),
    )
    .join('\n    ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <div class="window">Window: ${escapeHtml(formatWindow(report.window))}</div>
    </header>
    <div class="cards">
      ${cards}
    </div>
    ${sections}
    <footer>Served by <code>abacus</code> · spend governance for LLM calls</footer>
  </main>
</body>
</html>`;
}

/** Minimal HTML error page for the dashboard's non-200 responses. */
function renderError(heading: string, detail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(heading)} — abacus</title>
  <style>${STYLES}</style>
</head>
<body>
  <main>
    <section>
      <h2>${escapeHtml(heading)}</h2>
      <p>${escapeHtml(detail)}</p>
    </section>
  </main>
</body>
</html>`;
}

/** Options for {@link dashboardHandler}. */
export interface DashboardHandlerOptions {
  /** Where to read metered records from (same seam as the JSON endpoint). */
  source: UsageRecordSource;
  /**
   * Default dimensions to roll up by when the request names none. Defaults to
   * all of tenant / feature / user; a request narrows it with `?dimension=`.
   */
  dimensions?: readonly AttributionDimension[];
  /** Group key for records missing a dimension; see {@link rollupByDimension}. */
  unattributedKey?: string;
  /** Page title; see {@link DashboardRenderOptions.title}. */
  title?: string;
}

function html(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

/**
 * A framework-agnostic spend dashboard: the HTML companion to {@link usageHandler}.
 * It is the same Web Fetch handler shape (`(request: Request) => Promise<Response>`)
 * over the same `dimension` / `since` / `until` query surface, but renders the
 * {@link UsageReport} as the self-contained {@link renderUsageDashboard} page
 * instead of JSON — the spec's "small dashboard ... showing spend by dimension".
 *
 * Mount it anywhere `usageHandler` mounts (Next.js, Hono, Bun, Deno, Workers):
 *
 * ```ts
 * export const GET = dashboardHandler({ source: () => sink.records });
 * ```
 *
 * Like the JSON endpoint it never throws: a bad query is a `400`, a non-`GET`
 * method a `405`, and a failing source a `500`, each as a small HTML error page.
 */
export function dashboardHandler(
  options: DashboardHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return html(
        renderError('Method not allowed', `${method} is not supported; use GET.`),
        405,
        { allow: 'GET, HEAD' },
      );
    }

    const params = new URL(request.url).searchParams;
    const reportOptions = usageReportOptionsFromQuery(params, {
      dimensions: options.dimensions,
      unattributedKey: options.unattributedKey,
    });
    if (isUsageQueryError(reportOptions)) {
      return html(renderError('Bad request', reportOptions.error), 400);
    }

    let records: readonly MeterRecord[];
    try {
      records = await options.source();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return html(renderError('Usage source failed', message), 500);
    }

    const report = buildUsageReport(records, reportOptions);
    const renderOptions =
      options.title === undefined ? undefined : { title: options.title };
    return html(renderUsageDashboard(report, renderOptions));
  };
}
