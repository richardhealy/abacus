/**
 * Reading per-call attribution off an AI SDK call's `providerOptions`. {@link
 * attributionFromProviderOptions} coerces the `abacus` namespace into an {@link
 * Attribution} (ignoring anything malformed — attribution must never break the
 * call), and {@link mergeAttribution} layers a per-call value over a middleware's
 * static default. Reading from `providerOptions` is what keeps integration to one
 * line: the same wrapped model serves every tenant.
 *
 * @module
 */
import type { SharedV3ProviderOptions } from '@ai-sdk/provider';
import type { Attribution } from './types.js';

/**
 * The namespace under an AI SDK call's `providerOptions` where abacus reads
 * per-call attribution. A caller tags a single request like:
 *
 * ```ts
 * await generateText({
 *   model,
 *   prompt: '…',
 *   providerOptions: { abacus: { tenant: 'acme', feature: 'chat', user: 'u_1' } },
 * });
 * ```
 *
 * Reading attribution from `providerOptions` (rather than a bespoke wrapper)
 * keeps the one-line integration intact: the same wrapped model serves every
 * tenant, and attribution rides along on the call it describes.
 */
export const ATTRIBUTION_PROVIDER_KEY = 'abacus';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a string-valued property, or `undefined` if absent / not a string. */
function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** Keep only the string-valued entries of an object; drop the rest. */
function stringTags(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const tags: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') tags[key] = raw;
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

/** `true` when an attribution carries no dimension and no tags. */
function isEmpty(attribution: Attribution): boolean {
  return (
    attribution.tenant === undefined &&
    attribution.feature === undefined &&
    attribution.user === undefined &&
    attribution.tags === undefined
  );
}

/**
 * Extract per-call {@link Attribution} from an AI SDK call's `providerOptions`.
 *
 * Reads the {@link ATTRIBUTION_PROVIDER_KEY} namespace and coerces it into an
 * {@link Attribution}, keeping only string-valued `tenant` / `feature` / `user`
 * and string-valued `tags`. Anything malformed is ignored rather than thrown —
 * attribution is best-effort metadata and must never break the wrapped call.
 * Returns `undefined` when no usable attribution is present.
 */
export function attributionFromProviderOptions(
  providerOptions: SharedV3ProviderOptions | undefined,
): Attribution | undefined {
  const raw = providerOptions?.[ATTRIBUTION_PROVIDER_KEY];
  if (!isObject(raw)) return undefined;

  const attribution: Attribution = {};
  const tenant = str(raw, 'tenant');
  const feature = str(raw, 'feature');
  const user = str(raw, 'user');
  const tags = stringTags(raw.tags);
  if (tenant !== undefined) attribution.tenant = tenant;
  if (feature !== undefined) attribution.feature = feature;
  if (user !== undefined) attribution.user = user;
  if (tags !== undefined) attribution.tags = tags;

  return isEmpty(attribution) ? undefined : attribution;
}

/**
 * Merge a static, wrap-time attribution `base` with a per-call `override`.
 *
 * Named dimensions resolve per field — the override's value wins when present,
 * otherwise the base's is kept — so a middleware configured with
 * `{ feature: 'chat' }` still records the per-call `tenant`/`user`. Tags are
 * shallow-merged, with override keys winning. Returns `undefined` when the
 * merge yields nothing to record.
 */
export function mergeAttribution(
  base: Attribution | undefined,
  override: Attribution | undefined,
): Attribution | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;

  const merged: Attribution = {};
  const tenant = override.tenant ?? base.tenant;
  const feature = override.feature ?? base.feature;
  const user = override.user ?? base.user;
  if (tenant !== undefined) merged.tenant = tenant;
  if (feature !== undefined) merged.feature = feature;
  if (user !== undefined) merged.user = user;

  if (base.tags !== undefined || override.tags !== undefined) {
    merged.tags = { ...base.tags, ...override.tags };
  }

  return isEmpty(merged) ? undefined : merged;
}
