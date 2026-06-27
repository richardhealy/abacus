/**
 * Attribution dimensions: the named axes spend is grouped and budgeted by.
 *
 * These mirror the spec's "tenant / feature / user" attribution. The budget
 * store (M3) keys limits on these same dimensions, so the set is deliberately
 * small and shared — adding a dimension here is the one place it needs to change.
 */
export type AttributionDimension = 'tenant' | 'feature' | 'user';

/** The three named attribution dimensions, in a stable, iterable order. */
export const ATTRIBUTION_DIMENSIONS: readonly AttributionDimension[] = [
  'tenant',
  'feature',
  'user',
];

/**
 * Who/what a metered call should be attributed to.
 *
 * Every field is optional: a call may be attributed on any subset of the
 * dimensions, or none. The three named dimensions are first-class because the
 * budget engine keys limits on them; arbitrary extra context goes in {@link
 * Attribution.tags} (for example `env: "prod"` or `region: "eu"`), which the
 * rollups can group on but the budget engine ignores.
 */
export interface Attribution {
  /** The paying tenant / organization, e.g. `"acme"`. */
  tenant?: string;
  /** The product feature making the call, e.g. `"chat"` or `"summarize"`. */
  feature?: string;
  /** The end user on whose behalf the call is made, e.g. `"u_123"`. */
  user?: string;
  /** Free-form extra tags for dimensions beyond the three named ones. */
  tags?: Record<string, string>;
}
