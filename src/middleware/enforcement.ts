import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import {
  attributionFromProviderOptions,
  mergeAttribution,
} from '../attribution/provider-options.js';
import type { Attribution } from '../attribution/types.js';
import type { BudgetLedger } from '../budget/ledger.js';
import type { BudgetState } from '../budget/types.js';
import { decide } from '../policy/engine.js';
import type {
  CacheAction,
  Policy,
  PolicyAction,
  RefuseAction,
} from '../policy/types.js';
import { costOf, priceFor } from '../pricing/cost.js';
import type { PriceTable } from '../pricing/types.js';
import type { TokenUsage } from './types.js';
import { normalizeUsage, zeroUsage } from './usage.js';

/**
 * Thrown by the enforcement middleware when a policy decides to {@link
 * RefuseAction refuse} a call (the spec's hard-limit behavior). It carries the
 * triggering {@link BudgetState} and the engine's reason, so a caller can catch
 * it, surface a clean message, and know exactly which budget closed the door —
 * without re-deriving anything.
 *
 * ```ts
 * try {
 *   await generateText({ model, prompt, providerOptions: { abacus: { tenant } } });
 * } catch (err) {
 *   if (err instanceof BudgetExceededError) return res.status(429).json({ error: err.message });
 *   throw err;
 * }
 * ```
 */
export class BudgetExceededError extends Error {
  /** The refuse action the policy engine produced. */
  readonly action: RefuseAction;
  /** The budget whose level drove the refusal. */
  readonly trigger: BudgetState;

  constructor(action: RefuseAction) {
    super(action.reason);
    this.name = 'BudgetExceededError';
    this.action = action;
    this.trigger = action.trigger;
  }
}

/**
 * Resolves a model id to a concrete model instance — the seam a downshift
 * needs to actually *call* a cheaper model than the
 * one wrapped. The policy engine picks the target id; this turns that id into a
 * runnable model (e.g. `gateway('anthropic/claude-haiku-4')` or a lookup in a
 * `createProviderRegistry`). Returning `undefined` means "I can't produce that
 * model", and the middleware falls back to the originally requested one rather
 * than failing the call.
 */
export type ModelResolver = (
  modelId: string,
) => LanguageModelV3 | undefined;

/**
 * A read-through cache the enforcement layer can serve from when a policy
 * decides to {@link CacheAction cache} instead of spending. abacus does not own
 * a cache; this is the hook where the caller's cache plugs in. Both methods are
 * optional and may be async — a miss returns `undefined`, and the middleware
 * falls through to the live (priced) call.
 */
export interface GovernanceCache {
  /** Look up a cached buffered result for a `cache` decision, or `undefined`. */
  lookupGenerate?(
    params: LanguageModelV3CallOptions,
    action: CacheAction,
  ): PromiseLike<LanguageModelV3GenerateResult | undefined> | LanguageModelV3GenerateResult | undefined;
  /** Look up a cached stream for a `cache` decision, or `undefined`. */
  lookupStream?(
    params: LanguageModelV3CallOptions,
    action: CacheAction,
  ): PromiseLike<LanguageModelV3StreamResult | undefined> | LanguageModelV3StreamResult | undefined;
}

/** Where in the enforcement flow a (non-fatal) error came from. */
export interface EnforcementErrorContext {
  /** `'check'` reading budget state before the call; `'charge'` accruing after. */
  phase: 'check' | 'charge';
  /** The call's attribution, when known. */
  attribution?: Attribution | undefined;
}

export interface EnforcementOptions {
  /**
   * The budget ledger this middleware reads before a call (to decide) and
   * charges after (to accrue spend). The same ledger instance should govern
   * every wrapped model so spend accumulates across calls.
   */
  ledger: BudgetLedger;
  /**
   * The policy mapping a crossed budget level to an action. Defaults inside the
   * engine are conservative — observe at soft, refuse at hard — so degradation
   * is opt-in (see {@link Policy}).
   */
  policy: Policy;
  /**
   * Price table used to compute the cost charged to the ledger after each call.
   * Required: charging is the point of enforcement, and cost is derived from the
   * *executed* model's usage and price (so a downshift accrues the cheaper
   * model's spend). An unpriced executed model accrues nothing and is surfaced
   * via {@link EnforcementOptions.onUnpricedModel}.
   */
  prices: PriceTable;
  /**
   * Resolves a downshift target id to a runnable model. Omit it and a downshift
   * decision can never execute — the call falls back to the requested model. A
   * resolver that returns `undefined` for a given target has the same fallback.
   */
  resolveModel?: ModelResolver;
  /** Optional read-through cache for `cache` decisions. */
  cache?: GovernanceCache;
  /**
   * Static attribution merged under each call's per-call
   * `providerOptions.abacus` (per-call values win field by field), mirroring the
   * metering middleware. Useful when one wrapped model serves a single feature.
   */
  attribution?: Attribution;
  /**
   * Clock for the timestamp used to pick the budget window. Captured once per
   * call and shared by the pre-call read and post-call charge, so both land in
   * the same window even if the call straddles a boundary. Defaults to
   * `Date.now`; injectable for deterministic tests.
   */
  now?: () => number;
  /**
   * Invoked when the ledger throws while reading or charging spend. Enforcement
   * is a cross-cutting concern and must not break the wrapped call: a failed
   * read **fails open** (the call proceeds as if under no budgets) and a failed
   * charge is dropped, both routed here. Defaults to logging. Operators who want
   * to fail *closed* on a store outage should do so by wrapping the ledger.
   */
  onError?: (error: unknown, context: EnforcementErrorContext) => void;
  /**
   * Invoked the first time an executed model has no entry in {@link
   * EnforcementOptions.prices}. Its spend cannot be charged, so the budget would
   * silently never grow — this surfaces the gap. Fired at most once per model id.
   */
  onUnpricedModel?: (modelId: string) => void;
}

function defaultOnError(
  error: unknown,
  context: EnforcementErrorContext,
): void {
  console.error(
    `[abacus] budget ledger failed during ${context.phase}; call proceeds:`,
    error,
  );
}

function defaultOnUnpricedModel(modelId: string): void {
  console.warn(
    `[abacus] no price configured for executed model "${modelId}"; budget not charged`,
  );
}

/**
 * AI SDK middleware that *enforces* a cost-governance policy in the model-call
 * path — the companion to {@link meteringMiddleware}, which only observes. For
 * every call it reads the budgets the call falls under (via the {@link
 * BudgetLedger}), asks the pure policy engine what to do, and executes that
 * decision:
 *
 * - **allow** — run the requested model.
 * - **downshift** — run a cheaper model instead (resolved via {@link
 *   EnforcementOptions.resolveModel}); falls back to the requested model if the
 *   target can't be resolved.
 * - **cache** — serve a cached response if {@link EnforcementOptions.cache}
 *   returns a hit; otherwise fall through to the live call.
 * - **refuse** — throw a {@link BudgetExceededError} without spending.
 *
 * After any executed call (allow / downshift / cache-miss), it charges the
 * executed model's cost back to the ledger, so the next call sees the updated
 * spend. The decision uses spend *before* the call and the charge updates it
 * *after* — a call's own cost is not known until it returns, so crossing a limit
 * governs the *next* call, which is the realistic model. Reading and charging
 * are isolated through {@link EnforcementOptions.onError}: a ledger outage never
 * breaks the wrapped call (it fails open).
 *
 * Both the buffered (`generateText`) and streaming (`streamText`) paths are
 * enforced. Wrap a model with both middlewares to meter *and* enforce:
 *
 * ```ts
 * const model = wrapLanguageModel({
 *   model: gateway('anthropic/claude-opus-4'),
 *   middleware: [
 *     enforcementMiddleware({ ledger, policy, prices, resolveModel }),
 *     meteringMiddleware({ sink, prices }),
 *   ],
 * });
 * ```
 */
export function enforcementMiddleware(
  options: EnforcementOptions,
): LanguageModelV3Middleware {
  const { ledger, policy, prices, resolveModel, cache } = options;
  const now = options.now ?? Date.now;
  const onError = options.onError ?? defaultOnError;
  const onUnpricedModel = options.onUnpricedModel ?? defaultOnUnpricedModel;
  const defaultAttribution = options.attribution;
  const warnedModels = new Set<string>();

  function resolveAttribution(
    params: LanguageModelV3CallOptions,
  ): Attribution | undefined {
    return mergeAttribution(
      defaultAttribution,
      attributionFromProviderOptions(params.providerOptions),
    );
  }

  /**
   * Read the budget states a call falls under. Fails open: a ledger read error
   * yields no states (so the policy allows), routed through `onError`. The
   * timestamp is shared with the later charge so both land in the same window.
   */
  async function readStates(
    attribution: Attribution | undefined,
    at: number,
  ): Promise<BudgetState[]> {
    try {
      return await ledger.check(attribution, at);
    } catch (error) {
      onError(error, { phase: 'check', attribution });
      return [];
    }
  }

  /**
   * Accrue the executed call's cost to the ledger. Cost is derived from the
   * *executed* model's id and usage, so a downshift charges the cheaper rate. An
   * unpriced model is warned once and charged nothing; a ledger write failure is
   * routed through `onError` and never surfaces to the caller.
   */
  async function charge(
    executedModelId: string,
    usage: TokenUsage,
    attribution: Attribution | undefined,
    at: number,
  ): Promise<void> {
    const price = priceFor(executedModelId, prices);
    if (price === undefined) {
      if (!warnedModels.has(executedModelId)) {
        warnedModels.add(executedModelId);
        onUnpricedModel(executedModelId);
      }
      return;
    }
    const cost = costOf(usage, price).totalCost;
    try {
      await ledger.charge(attribution, cost, at);
    } catch (error) {
      onError(error, { phase: 'charge', attribution });
    }
  }

  /** Run a buffered call via `run`, then charge `executedModelId`'s cost. */
  async function executeGenerate(
    run: () => PromiseLike<LanguageModelV3GenerateResult>,
    executedModelId: string,
    attribution: Attribution | undefined,
    at: number,
  ): Promise<LanguageModelV3GenerateResult> {
    const result = await run();
    await charge(executedModelId, normalizeUsage(result.usage), attribution, at);
    return result;
  }

  /**
   * Run a streamed call via `run` and pipe its parts through a tap that captures
   * usage from the terminal `finish` part and charges `executedModelId` once the
   * stream drains — the same non-buffering pattern the metering middleware uses,
   * so enforcement adds no latency to the stream itself.
   */
  async function executeStream(
    run: () => PromiseLike<LanguageModelV3StreamResult>,
    executedModelId: string,
    attribution: Attribution | undefined,
    at: number,
  ): Promise<LanguageModelV3StreamResult> {
    const { stream, ...rest } = await run();
    let usage: LanguageModelV3Usage | undefined;
    const tap = new TransformStream<
      LanguageModelV3StreamPart,
      LanguageModelV3StreamPart
    >({
      transform(part, controller) {
        if (part.type === 'finish') usage = part.usage;
        controller.enqueue(part);
      },
      flush: async () => {
        const normalized =
          usage === undefined ? zeroUsage() : normalizeUsage(usage);
        await charge(executedModelId, normalized, attribution, at);
      },
    });
    return { ...rest, stream: stream.pipeThrough(tap) };
  }

  return {
    specificationVersion: 'v3',

    wrapGenerate: async ({ doGenerate, model, params }) => {
      const at = now();
      const attribution = resolveAttribution(params);
      const states = await readStates(attribution, at);
      const action: PolicyAction = decide(policy, states, {
        modelId: model.modelId,
      });

      switch (action.type) {
        case 'refuse':
          throw new BudgetExceededError(action);
        case 'cache': {
          const hit = await cache?.lookupGenerate?.(params, action);
          if (hit !== undefined) return hit;
          return executeGenerate(doGenerate, model.modelId, attribution, at);
        }
        case 'downshift': {
          const target = resolveModel?.(action.model);
          if (target === undefined) {
            return executeGenerate(doGenerate, model.modelId, attribution, at);
          }
          return executeGenerate(
            () => target.doGenerate(params),
            target.modelId,
            attribution,
            at,
          );
        }
        case 'allow':
          return executeGenerate(doGenerate, model.modelId, attribution, at);
      }
    },

    wrapStream: async ({ doStream, model, params }) => {
      const at = now();
      const attribution = resolveAttribution(params);
      const states = await readStates(attribution, at);
      const action: PolicyAction = decide(policy, states, {
        modelId: model.modelId,
      });

      switch (action.type) {
        case 'refuse':
          throw new BudgetExceededError(action);
        case 'cache': {
          const hit = await cache?.lookupStream?.(params, action);
          if (hit !== undefined) return hit;
          return executeStream(doStream, model.modelId, attribution, at);
        }
        case 'downshift': {
          const target = resolveModel?.(action.model);
          if (target === undefined) {
            return executeStream(doStream, model.modelId, attribution, at);
          }
          return executeStream(
            () => target.doStream(params),
            target.modelId,
            attribution,
            at,
          );
        }
        case 'allow':
          return executeStream(doStream, model.modelId, attribution, at);
      }
    },
  };
}
