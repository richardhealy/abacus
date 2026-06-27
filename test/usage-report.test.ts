import { describe, expect, it } from 'vitest';
import type { MeterRecord } from '../src/index.js';
import { buildUsageReport } from '../src/index.js';

function record(overrides: Partial<MeterRecord> = {}): MeterRecord {
  return {
    modelId: 'anthropic/claude-opus-4',
    provider: 'anthropic',
    timestamp: 1_000,
    latencyMs: 100,
    usage: {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
    cost: 0.01,
    ...overrides,
  };
}

describe('buildUsageReport', () => {
  it('sums totals across every record', () => {
    const report = buildUsageReport([
      record({ cost: 0.01, usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, cachedInputTokens: 0, reasoningTokens: 0 } }),
      record({ cost: 0.02, usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedInputTokens: 5, reasoningTokens: 2 } }),
    ]);

    expect(report.totals).toEqual({
      count: 2,
      usage: {
        inputTokens: 150,
        outputTokens: 50,
        totalTokens: 200,
        cachedInputTokens: 5,
        reasoningTokens: 2,
      },
      cost: 0.03,
    });
  });

  it('rolls up by all three dimensions by default', () => {
    const report = buildUsageReport([
      record({ attribution: { tenant: 'acme', feature: 'chat', user: 'u1' } }),
      record({ attribution: { tenant: 'globex', feature: 'chat', user: 'u2' } }),
    ]);

    expect(Object.keys(report.byDimension).sort()).toEqual(['feature', 'tenant', 'user']);
    expect(report.byDimension.tenant?.map((e) => e.key)).toEqual(['acme', 'globex']);
    // Both calls share the chat feature, so it groups into one entry.
    expect(report.byDimension.feature).toEqual([
      { key: 'chat', count: 2, usage: expect.any(Object), cost: 0.02 },
    ]);
  });

  it('restricts to the requested dimensions', () => {
    const report = buildUsageReport([record({ attribution: { tenant: 'acme' } })], {
      dimensions: ['tenant'],
    });

    expect(Object.keys(report.byDimension)).toEqual(['tenant']);
    expect(report.byDimension.feature).toBeUndefined();
  });

  it('sorts rollup entries by cost descending', () => {
    const report = buildUsageReport(
      [
        record({ cost: 0.01, attribution: { tenant: 'cheap' } }),
        record({ cost: 0.5, attribution: { tenant: 'pricey' } }),
      ],
      { dimensions: ['tenant'] },
    );

    expect(report.byDimension.tenant?.map((e) => e.key)).toEqual(['pricey', 'cheap']);
  });

  it('filters to [since, until): since inclusive, until exclusive', () => {
    const records = [
      record({ timestamp: 100 }),
      record({ timestamp: 200 }),
      record({ timestamp: 300 }),
    ];

    const report = buildUsageReport(records, { since: 200, until: 300, dimensions: ['tenant'] });

    // 100 excluded (< since), 200 included (>= since), 300 excluded (== until).
    expect(report.totals.count).toBe(1);
    expect(report.window).toEqual({ since: 200, until: 300 });
  });

  it('treats both window bounds as optional', () => {
    const records = [record({ timestamp: 100 }), record({ timestamp: 900 })];

    expect(buildUsageReport(records, { since: 500 }).totals.count).toBe(1);
    expect(buildUsageReport(records, { until: 500 }).totals.count).toBe(1);
    expect(buildUsageReport(records).window).toEqual({ since: null, until: null });
  });

  it('collects records missing the dimension under the unattributed key', () => {
    const report = buildUsageReport(
      [record({ attribution: { tenant: 'acme' } }), record()],
      { dimensions: ['tenant'] },
    );

    expect(report.byDimension.tenant?.map((e) => e.key)).toContain('(unattributed)');
  });

  it('honors a custom unattributed key', () => {
    const report = buildUsageReport([record()], {
      dimensions: ['tenant'],
      unattributedKey: 'none',
    });

    expect(report.byDimension.tenant?.[0]?.key).toBe('none');
  });

  it('counts unpriced records but adds nothing to cost', () => {
    const unpriced = record();
    delete unpriced.cost; // an unpriced model carries no cost
    const report = buildUsageReport([unpriced, record({ cost: 0.05 })]);

    expect(report.totals.count).toBe(2);
    expect(report.totals.cost).toBe(0.05);
  });

  it('returns empty rollups and zero totals for no records', () => {
    const report = buildUsageReport([], { dimensions: ['tenant'] });

    expect(report.totals).toEqual({
      count: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
      cost: 0,
    });
    expect(report.byDimension.tenant).toEqual([]);
  });
});
