/**
 * Sample wrapped call.
 *
 * Demonstrates the one-line integration: wrap any AI SDK model with
 * `meteringMiddleware` and every call is metered automatically — the caller of
 * `generateText` never knows. A `MockLanguageModelV3` stands in for a real
 * provider so the example runs offline with no API keys.
 *
 * Run with: `npm run example`
 */
import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { generateText, streamText, wrapLanguageModel } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import {
  BudgetExceededError,
  BudgetLedger,
  defaultPrices,
  enforcementMiddleware,
  InMemoryBudgetStore,
  InMemoryMeterSink,
  meteringMiddleware,
  usageHandler,
  type Policy,
} from '../src/index.js';

const usage = {
  inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

// A token stream for the streaming demo, ending with the usage-bearing `finish`.
const streamParts: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: 'Paris is ' },
  { type: 'text-delta', id: '0', delta: 'the capital of France.' },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

const sink = new InMemoryMeterSink();

// --- before: a plain model call (no governance) ---
//   const model = new MockLanguageModelV3({ ... });
//
// --- after: the same model, now metered AND priced (one line) ---
// Passing `prices` makes every record carry its cost in USD. The model id below
// (`anthropic/claude-opus-4`) resolves against the bundled `defaultPrices`. The
// one wrap meters both the buffered (`generateText`) and streaming
// (`streamText`) paths.
const model = wrapLanguageModel({
  model: new MockLanguageModelV3({
    provider: 'gateway',
    modelId: 'anthropic/claude-opus-4',
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: 'text', text: 'Paris is the capital of France.' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
    doStream: async () => ({ stream: convertArrayToReadableStream(streamParts) }),
  }),
  middleware: meteringMiddleware({ sink, prices: defaultPrices }),
});

// Attribution rides along on the call via `providerOptions.abacus`. The same
// wrapped model serves every tenant; each call says who it is for, and abacus
// tags the metered record so spend can be rolled up per tenant / feature / user.
const { text } = await generateText({
  model,
  prompt: 'What is the capital of France?',
  providerOptions: { abacus: { tenant: 'acme', feature: 'chat', user: 'u_1' } },
});

// A second call, billed to a different tenant.
await generateText({
  model,
  prompt: 'What is the capital of France?',
  providerOptions: { abacus: { tenant: 'globex', feature: 'chat', user: 'u_2' } },
});

// A streamed call — the same wrapped model meters it once the stream drains,
// reading usage from the terminal `finish` part. Billed to a third tenant.
const stream = streamText({
  model,
  prompt: 'What is the capital of France?',
  providerOptions: { abacus: { tenant: 'initech', feature: 'chat', user: 'u_3' } },
});
let streamed = '';
for await (const delta of stream.textStream) streamed += delta;

console.log('Model said (buffered):', text);
console.log('Model said (streamed):', streamed);
console.log('Metered records:', sink.records);
console.log('Token totals:', sink.totals());
console.log('Spend (USD):', sink.totalCost());
console.log('Spend by tenant:', sink.rollup('tenant'));

// --- The /usage endpoint: the same spend-by-dimension view over HTTP. ---
// `usageHandler` is a Web Fetch handler — mount it in Next.js / Hono / Bun / Deno
// with one line (`export const GET = usageHandler({ source: () => sink.records })`).
// Here we call it directly with a Request to show the JSON it returns.
const usageEndpoint = usageHandler({ source: () => sink.records });
const usageResponse = await usageEndpoint(
  new Request('http://localhost/usage?dimension=tenant'),
);
console.log(
  'GET /usage?dimension=tenant ->',
  JSON.stringify(await usageResponse.json(), null, 2),
);

// --- Enforcement (M3 + M4 in the call path): govern spend per tenant. ---
// Three tenants share one budget shape; we pre-load each to a different level so
// one call apiece shows every policy branch. In production the enforcement
// middleware charges the ledger as calls happen and acts on the level it reports.
const ledger = new BudgetLedger({
  store: new InMemoryBudgetStore(),
  budgets: ['acme', 'globex', 'initech'].map((key) => ({
    dimension: 'tenant' as const,
    key,
    window: 'monthly' as const,
    soft: 1,
    hard: 2,
  })),
});
await ledger.charge({ tenant: 'globex' }, 1); // -> at soft limit
await ledger.charge({ tenant: 'initech' }, 2); // -> at hard limit

// The policy: on soft, downshift Opus -> Haiku via the Gateway; on hard, refuse.
const policy: Policy = {
  soft: { kind: 'downshift', to: { 'anthropic/claude-opus-4': 'anthropic/claude-haiku-4' } },
  hard: { kind: 'refuse' },
};

// A cheaper model the downshift can resolve to, and a resolver that produces it.
const haiku = new MockLanguageModelV3({
  provider: 'gateway',
  modelId: 'anthropic/claude-haiku-4',
  doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
    content: [{ type: 'text', text: 'Paris.' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  }),
});

// One wrapped model, now metered AND governed — still a one-line integration.
// enforcement runs first (outermost) so it decides before metering observes.
const governed = wrapLanguageModel({
  model,
  middleware: [
    enforcementMiddleware({
      ledger,
      policy,
      prices: defaultPrices,
      resolveModel: (id) => (id === 'anthropic/claude-haiku-4' ? haiku : undefined),
    }),
    meteringMiddleware({ sink: new InMemoryMeterSink(), prices: defaultPrices }),
  ],
});

for (const tenant of ['acme', 'globex', 'initech']) {
  try {
    const { text: answer } = await generateText({
      model: governed,
      prompt: 'What is the capital of France?',
      providerOptions: { abacus: { tenant } },
    });
    console.log(`Enforced call for ${tenant}: allowed/downshifted ->`, answer);
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      console.log(`Enforced call for ${tenant}: refused ->`, error.message);
    } else {
      throw error;
    }
  }
}
