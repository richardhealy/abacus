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
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { generateText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { InMemoryMeterSink, meteringMiddleware } from '../src/index.js';

const sink = new InMemoryMeterSink();

// --- before: a plain model call (no governance) ---
//   const model = new MockLanguageModelV3({ ... });
//
// --- after: the same model, now metered (one line) ---
const model = wrapLanguageModel({
  model: new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock/opus',
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: 'text', text: 'Paris is the capital of France.' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 42, noCache: 42, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 8, text: 8, reasoning: 0 },
      },
      warnings: [],
    }),
  }),
  middleware: meteringMiddleware({ sink }),
});

const { text } = await generateText({
  model,
  prompt: 'What is the capital of France?',
});

console.log('Model said:', text);
console.log('Metered records:', sink.records);
console.log('Token totals:', sink.totals());
