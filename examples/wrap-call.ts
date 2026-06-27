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
  defaultPrices,
  InMemoryMeterSink,
  meteringMiddleware,
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
