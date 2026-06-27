import type { Attribution } from '../attribution/types.js';
import type { MeterRecord } from '../middleware/types.js';

/**
 * Attribute and metric values OpenTelemetry accepts. A deliberately small
 * mirror of `@opentelemetry/api`'s `AttributeValue`, so abacus can build
 * attribute bags without a runtime dependency on the OTel API. The real
 * `Attributes` type is a structural supertype, so a bag built here drops
 * straight into a real tracer or meter.
 */
export type OTelAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

/** A flat bag of OpenTelemetry attributes keyed by attribute name. */
export type OTelAttributes = Record<string, OTelAttributeValue>;

// OpenTelemetry GenAI semantic-convention attribute keys. These are the cross-
// provider names a tracing backend (and watchtower) understands, so a metered
// call shows up in the same shape as any other instrumented LLM call.
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const ATTR_GEN_AI_SYSTEM = 'gen_ai.system';
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
/** Distinguishes the two series of the token-usage histogram: `input` / `output`. */
export const ATTR_GEN_AI_TOKEN_TYPE = 'gen_ai.token.type';

// abacus-owned attributes for the things GenAI semconv has no key for: the
// computed cost, the extra token breakdowns, and the spend attribution. They
// share the `abacus.` namespace so they are easy to spot and filter on.
export const ATTR_ABACUS_COST_USD = 'abacus.cost.usd';
export const ATTR_ABACUS_TOTAL_TOKENS = 'abacus.usage.total_tokens';
export const ATTR_ABACUS_CACHED_INPUT_TOKENS = 'abacus.usage.cached_input_tokens';
export const ATTR_ABACUS_REASONING_TOKENS = 'abacus.usage.reasoning_tokens';
/** Prefix for free-form attribution tags, e.g. `abacus.tag.env`. */
export const ATTR_ABACUS_TAG_PREFIX = 'abacus.tag.';

// OpenTelemetry GenAI instrument names. The two `gen_ai.client.*` histograms are
// from the semconv; the cost counter is abacus's own — spend is its domain, not
// a standard GenAI metric.
export const METRIC_GEN_AI_TOKEN_USAGE = 'gen_ai.client.token.usage';
export const METRIC_GEN_AI_OPERATION_DURATION = 'gen_ai.client.operation.duration';
export const METRIC_ABACUS_COST_USD = 'abacus.cost.usd';

/** GenAI token-type values, used as the `gen_ai.token.type` attribute. */
export const TOKEN_TYPE_INPUT = 'input';
export const TOKEN_TYPE_OUTPUT = 'output';

/**
 * Default `gen_ai.operation.name`. A {@link MeterRecord} does not say which kind
 * of call it was, and chat completion is by far the most common, so spans and
 * metrics are tagged `chat` unless the sink is told otherwise.
 */
export const DEFAULT_OPERATION_NAME = 'chat';

/**
 * The GenAI span name for a call: `"{operation} {model}"`, e.g.
 * `"chat anthropic/claude-opus-4"`. This is the naming the GenAI semantic
 * conventions prescribe, so spans group by operation and model in any backend.
 */
export function spanName(operationName: string, modelId: string): string {
  return `${operationName} ${modelId}`;
}

/**
 * The attribution-derived attributes for a call: each present named dimension as
 * `abacus.tenant` / `abacus.feature` / `abacus.user`, and each free-form tag as
 * `abacus.tag.<key>`. Absent fields are omitted (never set to `undefined`), so
 * an unattributed call contributes no attribution attributes at all. This is
 * what makes spend filterable by tenant or feature in the tracing tool.
 */
export function attributionAttributes(
  attribution: Attribution | undefined,
): OTelAttributes {
  const attrs: OTelAttributes = {};
  if (attribution === undefined) return attrs;

  if (attribution.tenant !== undefined) attrs['abacus.tenant'] = attribution.tenant;
  if (attribution.feature !== undefined) attrs['abacus.feature'] = attribution.feature;
  if (attribution.user !== undefined) attrs['abacus.user'] = attribution.user;
  if (attribution.tags !== undefined) {
    for (const [key, value] of Object.entries(attribution.tags)) {
      attrs[`${ATTR_ABACUS_TAG_PREFIX}${key}`] = value;
    }
  }
  return attrs;
}

/**
 * The low-cardinality base attributes shared by every span and metric for a
 * call: the operation, the provider (`gen_ai.system`), and the model on both the
 * request and response sides. abacus calls one model per record, so request and
 * response model are the same id.
 *
 * Kept deliberately small so it is safe to attach to histograms, where high-
 * cardinality keys (like a per-user id) would explode the time-series count.
 */
export function genAiMetricAttributes(
  record: MeterRecord,
  operationName: string = DEFAULT_OPERATION_NAME,
): OTelAttributes {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: operationName,
    [ATTR_GEN_AI_SYSTEM]: record.provider,
    [ATTR_GEN_AI_REQUEST_MODEL]: record.modelId,
    [ATTR_GEN_AI_RESPONSE_MODEL]: record.modelId,
  };
}

/**
 * The full attribute bag for a call's span: the GenAI base attributes, the token
 * usage (standard `gen_ai.usage.*` plus abacus's breakdowns), the computed cost
 * when present, and the attribution. Spans tolerate the higher cardinality of
 * attribution, so unlike {@link genAiMetricAttributes} this includes it — that
 * is how a single call is traceable back to its tenant/feature/user.
 *
 * `cost` is omitted when the record carries none, so a span can tell an unpriced
 * call apart from a genuinely free one.
 */
export function genAiSpanAttributes(
  record: MeterRecord,
  operationName: string = DEFAULT_OPERATION_NAME,
): OTelAttributes {
  const attrs: OTelAttributes = {
    ...genAiMetricAttributes(record, operationName),
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: record.usage.inputTokens,
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: record.usage.outputTokens,
    [ATTR_ABACUS_TOTAL_TOKENS]: record.usage.totalTokens,
    [ATTR_ABACUS_CACHED_INPUT_TOKENS]: record.usage.cachedInputTokens,
    [ATTR_ABACUS_REASONING_TOKENS]: record.usage.reasoningTokens,
    ...attributionAttributes(record.attribution),
  };
  if (record.cost !== undefined) {
    attrs[ATTR_ABACUS_COST_USD] = record.cost;
  }
  return attrs;
}
