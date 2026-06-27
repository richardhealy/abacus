import {
  ATTRIBUTION_DIMENSIONS,
  type AttributionDimension,
} from '../attribution/types.js';
import type { MeterRecord } from '../middleware/types.js';
import {
  buildUsageReport,
  type UsageReportOptions,
} from './report.js';

/**
 * Supplies the metered records a `/usage` request reports over. Sync or async.
 *
 * For the bundled in-memory sink this is a one-liner — `() => sink.records`. A
 * durable sink (Redis, a warehouse) returns a promise that fetches its rows.
 * The source is the read seam between the endpoint and wherever spend is stored,
 * mirroring how {@link MeterSink} is the write seam.
 */
export type UsageRecordSource = () =>
  | readonly MeterRecord[]
  | Promise<readonly MeterRecord[]>;

export interface UsageHandlerOptions {
  /** Where to read metered records from. */
  source: UsageRecordSource;
  /**
   * Default dimensions to roll up by when the request names none. Defaults to
   * all of tenant / feature / user. A request can still narrow this with one or
   * more `?dimension=` query parameters.
   */
  dimensions?: readonly AttributionDimension[];
  /** Group key for records missing a dimension; see {@link rollupByDimension}. */
  unattributedKey?: string;
}

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function isDimension(value: string): value is AttributionDimension {
  return (ATTRIBUTION_DIMENSIONS as readonly string[]).includes(value);
}

/** Parse `?dimension=` params (repeated or comma-separated), de-duplicated. */
function parseDimensions(
  params: URLSearchParams,
): { dimensions: AttributionDimension[] } | { error: string } {
  const raw = params
    .getAll('dimension')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const dimensions: AttributionDimension[] = [];
  for (const value of raw) {
    if (!isDimension(value)) {
      return {
        error: `unknown dimension "${value}"; expected one of ${ATTRIBUTION_DIMENSIONS.join(', ')}`,
      };
    }
    if (!dimensions.includes(value)) dimensions.push(value);
  }
  return { dimensions };
}

/** Parse an optional epoch-ms bound; absent/blank → `null`, non-numeric → error. */
function parseBound(
  params: URLSearchParams,
  name: string,
): number | null | { error: string } {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { error: `"${name}" must be a number (epoch ms), got "${raw}"` };
  }
  return value;
}

function hasError(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/**
 * A framework-agnostic `/usage` endpoint: a Web Fetch handler
 * (`(request: Request) => Promise<Response>`) that returns the spend-by-dimension
 * {@link UsageReport} as JSON. It satisfies the spec's "spend by tenant/feature
 * is visible via `/usage`" goal and drops into any Web-standard runtime — Next.js
 * route handlers (`export const GET = usageHandler({ … })`), Hono, Bun, Deno, or
 * Cloudflare Workers — with no added dependency.
 *
 * Query parameters (all optional):
 * - `dimension` — restrict the rollups to one or more dimensions, repeated
 *   (`?dimension=tenant&dimension=feature`) or comma-separated
 *   (`?dimension=tenant,feature`). Defaults to {@link UsageHandlerOptions.dimensions}.
 * - `since` — inclusive lower bound on a record's timestamp (epoch ms).
 * - `until` — exclusive upper bound on a record's timestamp (epoch ms).
 *
 * Responses are JSON: `200` with the report, `400` on an unknown dimension or
 * non-numeric bound, `405` for a non-`GET` method, and `500` if the record
 * source throws — the endpoint never propagates an exception to the runtime.
 */
export function usageHandler(
  options: UsageHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return json({ error: `method ${method} not allowed` }, 405, {
        allow: 'GET, HEAD',
      });
    }

    const params = new URL(request.url).searchParams;

    const parsedDimensions = parseDimensions(params);
    if (hasError(parsedDimensions)) return json({ error: parsedDimensions.error }, 400);

    const since = parseBound(params, 'since');
    if (hasError(since)) return json({ error: since.error }, 400);
    const until = parseBound(params, 'until');
    if (hasError(until)) return json({ error: until.error }, 400);

    // No `?dimension=` → fall back to the handler's configured default.
    const dimensions =
      parsedDimensions.dimensions.length > 0
        ? parsedDimensions.dimensions
        : options.dimensions;

    const reportOptions: UsageReportOptions = {};
    if (dimensions !== undefined) reportOptions.dimensions = dimensions;
    if (since !== null) reportOptions.since = since;
    if (until !== null) reportOptions.until = until;
    if (options.unattributedKey !== undefined) {
      reportOptions.unattributedKey = options.unattributedKey;
    }

    let records: readonly MeterRecord[];
    try {
      records = await options.source();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: `usage source failed: ${message}` }, 500);
    }

    return json(buildUsageReport(records, reportOptions));
  };
}
