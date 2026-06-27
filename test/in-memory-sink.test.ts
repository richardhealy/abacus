import { describe, expect, it } from 'vitest';
import type { MeterRecord } from '../src/index.js';
import { InMemoryMeterSink } from '../src/index.js';

function record(overrides: Partial<MeterRecord> = {}): MeterRecord {
  return {
    modelId: 'mock/opus',
    provider: 'mock',
    timestamp: 0,
    latencyMs: 10,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 2,
      reasoningTokens: 1,
    },
    ...overrides,
  };
}

describe('InMemoryMeterSink', () => {
  it('starts empty', () => {
    const sink = new InMemoryMeterSink();
    expect(sink.count).toBe(0);
    expect(sink.records).toEqual([]);
    expect(sink.totals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('captures records in order', () => {
    const sink = new InMemoryMeterSink();
    sink.record(record({ modelId: 'a' }));
    sink.record(record({ modelId: 'b' }));

    expect(sink.count).toBe(2);
    expect(sink.records.map((r) => r.modelId)).toEqual(['a', 'b']);
  });

  it('sums usage across records', () => {
    const sink = new InMemoryMeterSink();
    sink.record(record());
    sink.record(record());

    expect(sink.totals()).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      cachedInputTokens: 4,
      reasoningTokens: 2,
    });
  });

  it('clears captured records', () => {
    const sink = new InMemoryMeterSink();
    sink.record(record());
    sink.clear();

    expect(sink.count).toBe(0);
    expect(sink.totals().totalTokens).toBe(0);
  });

  it('rolls up captured records by an attribution dimension', () => {
    const sink = new InMemoryMeterSink();
    sink.record(record({ attribution: { tenant: 'acme' }, cost: 0.4 }));
    sink.record(record({ attribution: { tenant: 'acme' }, cost: 0.1 }));
    sink.record(record({ attribution: { tenant: 'globex' }, cost: 1 }));
    sink.record(record({ cost: 0.2 }));

    const byTenant = sink.rollup('tenant');

    expect(byTenant.map((e) => ({ key: e.key, count: e.count, cost: e.cost }))).toEqual([
      { key: 'globex', count: 1, cost: 1 },
      { key: 'acme', count: 2, cost: 0.5 },
      { key: '(unattributed)', count: 1, cost: 0.2 },
    ]);
  });
});
