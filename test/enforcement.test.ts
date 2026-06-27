import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { generateText, streamText, wrapLanguageModel } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import {
  BudgetExceededError,
  BudgetLedger,
  type Budget,
  type BudgetStore,
  type Policy,
  defaultPrices,
  enforcementMiddleware,
  InMemoryBudgetStore,
} from '../src/index.js';

// A single, fixed instant. Both the pre-charge and the middleware use it so all
// spend lands in one budget window deterministically.
const AT = Date.UTC(2026, 5, 15); // 2026-06-15

const sampleUsage: LanguageModelV3Usage = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

// Cost of `sampleUsage` under `defaultPrices`, by model (USD).
const OPUS_COST = (42 * 15 + 8 * 75) / 1_000_000; // 0.00123
const HAIKU_COST = (42 * 0.8 + 8 * 4) / 1_000_000; // 0.0000656

const OPUS = 'anthropic/claude-opus-4';
const HAIKU = 'anthropic/claude-haiku-4';

/** A buffered mock model whose `doGenerate` is a spy, returning `text`. */
function bufferedModel(
  modelId: string,
  text: string,
): { model: LanguageModelV3; doGenerate: ReturnType<typeof vi.fn> } {
  const doGenerate = vi.fn(
    async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: sampleUsage,
      warnings: [],
    }),
  );
  return {
    model: new MockLanguageModelV3({ provider: 'gateway', modelId, doGenerate }),
    doGenerate,
  };
}

function streamParts(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: text },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: sampleUsage },
  ];
}

/** A streaming mock model whose `doStream` is a spy, emitting `text`. */
function streamingModel(
  modelId: string,
  text: string,
): { model: LanguageModelV3; doStream: ReturnType<typeof vi.fn> } {
  const doStream = vi.fn(async () => ({
    stream: convertArrayToReadableStream(streamParts(text)),
  }));
  return {
    model: new MockLanguageModelV3({ provider: 'gateway', modelId, doStream }),
    doStream,
  };
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const delta of stream) out += delta;
  return out;
}

/** A ledger over one in-memory tenant budget, pinned to {@link AT}. */
function ledgerWith(budget: Budget): { ledger: BudgetLedger; store: InMemoryBudgetStore } {
  const store = new InMemoryBudgetStore();
  const ledger = new BudgetLedger({ store, budgets: [budget], now: () => AT });
  return { ledger, store };
}

const acme = { tenant: 'acme' } as const;

describe('enforcementMiddleware — buffered path', () => {
  it('allows a call under budget and charges the executed cost', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'monthly', hard: 1 });
    const { model, doGenerate } = bufferedModel(OPUS, 'opus');
    const wrapped = wrapLanguageModel({
      model,
      middleware: enforcementMiddleware({ ledger, policy: {}, prices: defaultPrices, now: () => AT }),
    });

    const { text } = await generateText({
      model: wrapped,
      prompt: 'hi',
      providerOptions: { abacus: acme },
    });

    expect(text).toBe('opus');
    expect(doGenerate).toHaveBeenCalledOnce();
    const [state] = await ledger.check(acme, AT);
    expect(state?.spent).toBeCloseTo(OPUS_COST, 9);
  });

  it('refuses a call at the hard limit and never touches the model', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'monthly', hard: 0.5 });
    await ledger.charge(acme, 0.5, AT); // push spend to the hard limit
    const { model, doGenerate } = bufferedModel(OPUS, 'opus');
    const wrapped = wrapLanguageModel({
      model,
      middleware: enforcementMiddleware({ ledger, policy: {}, prices: defaultPrices, now: () => AT }),
    });

    await expect(
      generateText({ model: wrapped, prompt: 'hi', providerOptions: { abacus: acme } }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(doGenerate).not.toHaveBeenCalled();
    // No further spend was charged — the budget stays exactly at the limit.
    const [state] = await ledger.check(acme, AT);
    expect(state?.spent).toBeCloseTo(0.5, 9);
  });

  it('carries the triggering budget state on the refusal error', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'daily', hard: 0.5 });
    await ledger.charge(acme, 0.6, AT);
    const wrapped = wrapLanguageModel({
      model: bufferedModel(OPUS, 'opus').model,
      middleware: enforcementMiddleware({ ledger, policy: {}, prices: defaultPrices, now: () => AT }),
    });

    const err = await generateText({
      model: wrapped,
      prompt: 'hi',
      providerOptions: { abacus: acme },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BudgetExceededError);
    const budgetErr = err as BudgetExceededError;
    expect(budgetErr.trigger.level).toBe('hard');
    expect(budgetErr.trigger.budget.key).toBe('acme');
    expect(budgetErr.message).toContain('acme');
  });

  it('downshifts at the soft limit and charges the cheaper model', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'monthly', soft: 0.001, hard: 10 });
    await ledger.charge(acme, 0.001, AT); // reach the soft limit
    const opus = bufferedModel(OPUS, 'opus');
    const haiku = bufferedModel(HAIKU, 'haiku');
    const policy: Policy = { soft: { kind: 'downshift', to: { [OPUS]: HAIKU } } };
    const wrapped = wrapLanguageModel({
      model: opus.model,
      middleware: enforcementMiddleware({
        ledger,
        policy,
        prices: defaultPrices,
        resolveModel: (id) => (id === HAIKU ? haiku.model : undefined),
        now: () => AT,
      }),
    });

    const { text } = await generateText({
      model: wrapped,
      prompt: 'hi',
      providerOptions: { abacus: acme },
    });

    expect(text).toBe('haiku'); // the downshifted model ran
    expect(opus.doGenerate).not.toHaveBeenCalled();
    expect(haiku.doGenerate).toHaveBeenCalledOnce();
    const [state] = await ledger.check(acme, AT);
    expect(state?.spent).toBeCloseTo(0.001 + HAIKU_COST, 9);
  });

  it('falls back to the requested model when no downshift target resolves', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'monthly', soft: 0.001, hard: 10 });
    await ledger.charge(acme, 0.001, AT);
    const opus = bufferedModel(OPUS, 'opus');
    const policy: Policy = { soft: { kind: 'downshift', to: { [OPUS]: HAIKU } } };
    const wrapped = wrapLanguageModel({
      model: opus.model,
      middleware: enforcementMiddleware({
        ledger,
        policy,
        prices: defaultPrices,
        resolveModel: () => undefined, // cannot produce the target instance
        now: () => AT,
      }),
    });

    const { text } = await generateText({
      model: wrapped,
      prompt: 'hi',
      providerOptions: { abacus: acme },
    });

    expect(text).toBe('opus'); // proceeded with the original
    expect(opus.doGenerate).toHaveBeenCalledOnce();
    const [state] = await ledger.check(acme, AT);
    expect(state?.spent).toBeCloseTo(0.001 + OPUS_COST, 9);
  });

  it('serves a cache hit without calling the model or charging', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'monthly', soft: 0.001, hard: 10 });
    await ledger.charge(acme, 0.001, AT);
    const opus = bufferedModel(OPUS, 'opus');
    const cached: LanguageModelV3GenerateResult = {
      content: [{ type: 'text', text: 'cached' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: sampleUsage,
      warnings: [],
    };
    const wrapped = wrapLanguageModel({
      model: opus.model,
      middleware: enforcementMiddleware({
        ledger,
        policy: { soft: { kind: 'cache' } },
        prices: defaultPrices,
        cache: { lookupGenerate: () => cached },
        now: () => AT,
      }),
    });

    const { text } = await generateText({
      model: wrapped,
      prompt: 'hi',
      providerOptions: { abacus: acme },
    });

    expect(text).toBe('cached');
    expect(opus.doGenerate).not.toHaveBeenCalled();
    const [state] = await ledger.check(acme, AT);
    expect(state?.spent).toBeCloseTo(0.001, 9); // no marginal spend
  });

  it('falls through to the live call on a cache miss', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'monthly', soft: 0.001, hard: 10 });
    await ledger.charge(acme, 0.001, AT);
    const opus = bufferedModel(OPUS, 'opus');
    const wrapped = wrapLanguageModel({
      model: opus.model,
      middleware: enforcementMiddleware({
        ledger,
        policy: { soft: { kind: 'cache' } },
        prices: defaultPrices,
        cache: { lookupGenerate: () => undefined }, // miss
        now: () => AT,
      }),
    });

    const { text } = await generateText({
      model: wrapped,
      prompt: 'hi',
      providerOptions: { abacus: acme },
    });

    expect(text).toBe('opus');
    expect(opus.doGenerate).toHaveBeenCalledOnce();
    const [state] = await ledger.check(acme, AT);
    expect(state?.spent).toBeCloseTo(0.001 + OPUS_COST, 9);
  });

  it('warns once and charges nothing for an unpriced executed model', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'monthly', hard: 10 });
    const onUnpricedModel = vi.fn();
    const wrapped = wrapLanguageModel({
      model: bufferedModel('mystery/model-x', 'x').model,
      middleware: enforcementMiddleware({
        ledger,
        policy: {},
        prices: defaultPrices,
        onUnpricedModel,
        now: () => AT,
      }),
    });

    await generateText({ model: wrapped, prompt: 'a', providerOptions: { abacus: acme } });
    await generateText({ model: wrapped, prompt: 'b', providerOptions: { abacus: acme } });

    expect(onUnpricedModel).toHaveBeenCalledTimes(1);
    expect(onUnpricedModel).toHaveBeenCalledWith('mystery/model-x');
    const [state] = await ledger.check(acme, AT);
    expect(state?.spent).toBe(0);
  });
});

describe('enforcementMiddleware — resilience', () => {
  /** A store whose reads or writes throw, to exercise the fail-open path. */
  function brokenStore(opts: { onRead?: boolean; onWrite?: boolean }): BudgetStore {
    return {
      async getSpend(): Promise<number> {
        if (opts.onRead) throw new Error('read down');
        return 0;
      },
      async addSpend(): Promise<number> {
        if (opts.onWrite) throw new Error('write down');
        return 0;
      },
    };
  }

  it('fails open and surfaces the error when the ledger read throws', async () => {
    const ledger = new BudgetLedger({
      store: brokenStore({ onRead: true }),
      budgets: [{ dimension: 'tenant', key: 'acme', window: 'monthly', hard: 0.0001 }],
      now: () => AT,
    });
    const onError = vi.fn();
    const { model, doGenerate } = bufferedModel(OPUS, 'opus');
    const wrapped = wrapLanguageModel({
      model,
      middleware: enforcementMiddleware({ ledger, policy: {}, prices: defaultPrices, onError, now: () => AT }),
    });

    const { text } = await generateText({
      model: wrapped,
      prompt: 'hi',
      providerOptions: { abacus: acme },
    });

    expect(text).toBe('opus'); // proceeded despite the over-tiny hard limit
    expect(doGenerate).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ phase: 'check' }));
  });

  it('returns the call result even when charging the ledger throws', async () => {
    const ledger = new BudgetLedger({
      store: brokenStore({ onWrite: true }),
      budgets: [{ dimension: 'tenant', key: 'acme', window: 'monthly', hard: 10 }],
      now: () => AT,
    });
    const onError = vi.fn();
    const wrapped = wrapLanguageModel({
      model: bufferedModel(OPUS, 'opus').model,
      middleware: enforcementMiddleware({ ledger, policy: {}, prices: defaultPrices, onError, now: () => AT }),
    });

    const { text } = await generateText({
      model: wrapped,
      prompt: 'hi',
      providerOptions: { abacus: acme },
    });

    expect(text).toBe('opus');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ phase: 'charge' }));
  });
});

describe('enforcementMiddleware — streaming path', () => {
  it('allows a streamed call and charges once the stream drains', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'monthly', hard: 1 });
    const { model } = streamingModel(OPUS, 'streamed');
    const wrapped = wrapLanguageModel({
      model,
      middleware: enforcementMiddleware({ ledger, policy: {}, prices: defaultPrices, now: () => AT }),
    });

    const result = streamText({ model: wrapped, prompt: 'hi', providerOptions: { abacus: acme } });
    const text = await drain(result.textStream);

    expect(text).toBe('streamed');
    const [state] = await ledger.check(acme, AT);
    expect(state?.spent).toBeCloseTo(OPUS_COST, 9);
  });

  it('downshifts a streamed call to the cheaper model', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'monthly', soft: 0.001, hard: 10 });
    await ledger.charge(acme, 0.001, AT);
    const opus = streamingModel(OPUS, 'opus-stream');
    const haiku = streamingModel(HAIKU, 'haiku-stream');
    const wrapped = wrapLanguageModel({
      model: opus.model,
      middleware: enforcementMiddleware({
        ledger,
        policy: { soft: { kind: 'downshift', to: { [OPUS]: HAIKU } } },
        prices: defaultPrices,
        resolveModel: (id) => (id === HAIKU ? haiku.model : undefined),
        now: () => AT,
      }),
    });

    const result = streamText({ model: wrapped, prompt: 'hi', providerOptions: { abacus: acme } });
    const text = await drain(result.textStream);

    expect(text).toBe('haiku-stream');
    expect(opus.doStream).not.toHaveBeenCalled();
    expect(haiku.doStream).toHaveBeenCalledOnce();
    const [state] = await ledger.check(acme, AT);
    expect(state?.spent).toBeCloseTo(0.001 + HAIKU_COST, 9);
  });

  it('refuses a streamed call at the hard limit without calling the model', async () => {
    const { ledger } = ledgerWith({ dimension: 'tenant', key: 'acme', window: 'monthly', hard: 0.5 });
    await ledger.charge(acme, 0.5, AT);
    const { model, doStream } = streamingModel(OPUS, 'streamed');
    const wrapped = wrapLanguageModel({
      model,
      middleware: enforcementMiddleware({ ledger, policy: {}, prices: defaultPrices, now: () => AT }),
    });

    // streamText surfaces a thrown doStream error through `onError` / the
    // `error` part of fullStream rather than rejecting textStream.
    const errors: unknown[] = [];
    const result = streamText({
      model: wrapped,
      prompt: 'hi',
      providerOptions: { abacus: acme },
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    for await (const part of result.fullStream) {
      if (part.type === 'error') errors.push(part.error);
    }

    expect(errors.some((e) => e instanceof BudgetExceededError)).toBe(true);
    expect(doStream).not.toHaveBeenCalled();
    const [state] = await ledger.check(acme, AT);
    expect(state?.spent).toBeCloseTo(0.5, 9);
  });
});
