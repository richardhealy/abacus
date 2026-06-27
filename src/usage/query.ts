/**
 * The shared `/usage` query parsing: {@link usageReportOptionsFromQuery} turns the
 * `dimension` / `since` / `until` parameters into {@link UsageReportOptions},
 * returning a {@link UsageQueryError} (never throwing) on bad input so a handler
 * maps it to a `400`. The JSON endpoint and the HTML dashboard both parse through
 * here, so their query surface can never drift.
 *
 * @module
 */
import {
  ATTRIBUTION_DIMENSIONS,
  type AttributionDimension,
} from '../attribution/types.js';
import type { UsageReportOptions } from './report.js';

/**
 * A parse failure carrying a human-readable message. Returned (never thrown) by
 * {@link usageReportOptionsFromQuery} so a handler can map it to a `400`.
 */
export interface UsageQueryError {
  error: string;
}

/** Narrow a parse result (or any value) to a {@link UsageQueryError}. */
export function isUsageQueryError(value: unknown): value is UsageQueryError {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/** Defaults a handler applies when the request omits the corresponding param. */
export interface UsageQueryDefaults {
  /** Dimensions to roll up by when the request names none. */
  dimensions?: readonly AttributionDimension[] | undefined;
  /** Group key for records missing a dimension; see {@link rollupByDimension}. */
  unattributedKey?: string | undefined;
}

function isDimension(value: string): value is AttributionDimension {
  return (ATTRIBUTION_DIMENSIONS as readonly string[]).includes(value);
}

/** Parse `?dimension=` params (repeated or comma-separated), de-duplicated. */
function parseDimensions(
  params: URLSearchParams,
): AttributionDimension[] | UsageQueryError {
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
  return dimensions;
}

/** Parse an optional epoch-ms bound; absent/blank → `null`, non-numeric → error. */
function parseBound(
  params: URLSearchParams,
  name: string,
): number | null | UsageQueryError {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { error: `"${name}" must be a number (epoch ms), got "${raw}"` };
  }
  return value;
}

/**
 * Parse the shared `/usage` query parameters into {@link UsageReportOptions},
 * applying a handler's defaults. The query surface is common to both the JSON
 * endpoint and the HTML dashboard, so both parse through here:
 *
 * - `dimension` — restrict the rollups, repeated (`?dimension=tenant&dimension=feature`)
 *   or comma-separated (`?dimension=tenant,feature`). When absent, falls back to
 *   {@link UsageQueryDefaults.dimensions}.
 * - `since` — inclusive lower bound on a record's timestamp (epoch ms).
 * - `until` — exclusive upper bound on a record's timestamp (epoch ms).
 *
 * Pure and total: returns a {@link UsageQueryError} (rather than throwing) on an
 * unknown dimension or a non-numeric bound, so the caller maps it to a `400`.
 */
export function usageReportOptionsFromQuery(
  params: URLSearchParams,
  defaults: UsageQueryDefaults = {},
): UsageReportOptions | UsageQueryError {
  const dimensions = parseDimensions(params);
  if (isUsageQueryError(dimensions)) return dimensions;

  const since = parseBound(params, 'since');
  if (isUsageQueryError(since)) return since;
  const until = parseBound(params, 'until');
  if (isUsageQueryError(until)) return until;

  // No `?dimension=` → fall back to the handler's configured default.
  const resolved = dimensions.length > 0 ? dimensions : defaults.dimensions;

  const options: UsageReportOptions = {};
  if (resolved !== undefined) options.dimensions = resolved;
  if (since !== null) options.since = since;
  if (until !== null) options.until = until;
  if (defaults.unattributedKey !== undefined) {
    options.unattributedKey = defaults.unattributedKey;
  }
  return options;
}
