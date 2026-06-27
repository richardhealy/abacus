import { describe, expect, it } from 'vitest';
import type { MeterRecord, UsageReport } from '../src/index.js';
import { InMemoryMeterSink, usageHandler } from '../src/index.js';

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

const get = (url: string) => new Request(url);

describe('usageHandler', () => {
  it('returns a JSON report with the right content type', async () => {
    const sink = new InMemoryMeterSink();
    sink.record(record({ attribution: { tenant: 'acme' } }));
    const handler = usageHandler({ source: () => sink.records });

    const response = await handler(get('http://localhost/usage'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    const report = (await response.json()) as UsageReport;
    expect(report.totals.count).toBe(1);
    expect(report.byDimension.tenant?.[0]?.key).toBe('acme');
  });

  it('rolls up by all dimensions by default', async () => {
    const handler = usageHandler({ source: () => [record()] });

    const report = (await (await handler(get('http://localhost/usage'))).json()) as UsageReport;

    expect(Object.keys(report.byDimension).sort()).toEqual(['feature', 'tenant', 'user']);
  });

  it('narrows to a single ?dimension=', async () => {
    const handler = usageHandler({ source: () => [record({ attribution: { tenant: 'acme' } })] });

    const report = (await (
      await handler(get('http://localhost/usage?dimension=tenant'))
    ).json()) as UsageReport;

    expect(Object.keys(report.byDimension)).toEqual(['tenant']);
  });

  it('accepts comma-separated and repeated dimensions, de-duplicated', async () => {
    const handler = usageHandler({ source: () => [record()] });

    const comma = (await (
      await handler(get('http://localhost/usage?dimension=tenant,feature'))
    ).json()) as UsageReport;
    expect(Object.keys(comma.byDimension).sort()).toEqual(['feature', 'tenant']);

    const repeated = (await (
      await handler(get('http://localhost/usage?dimension=tenant&dimension=tenant&dimension=user'))
    ).json()) as UsageReport;
    expect(Object.keys(repeated.byDimension).sort()).toEqual(['tenant', 'user']);
  });

  it('falls back to the configured default dimensions', async () => {
    const handler = usageHandler({ source: () => [record()], dimensions: ['feature'] });

    const report = (await (await handler(get('http://localhost/usage'))).json()) as UsageReport;

    expect(Object.keys(report.byDimension)).toEqual(['feature']);
  });

  it('applies since/until window bounds from the query', async () => {
    const handler = usageHandler({
      source: () => [record({ timestamp: 100 }), record({ timestamp: 200 }), record({ timestamp: 300 })],
    });

    const report = (await (
      await handler(get('http://localhost/usage?since=200&until=300'))
    ).json()) as UsageReport;

    expect(report.totals.count).toBe(1);
    expect(report.window).toEqual({ since: 200, until: 300 });
  });

  it('400s on an unknown dimension', async () => {
    const handler = usageHandler({ source: () => [] });

    const response = await handler(get('http://localhost/usage?dimension=region'));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/unknown dimension/);
  });

  it('400s on a non-numeric bound', async () => {
    const handler = usageHandler({ source: () => [] });

    const response = await handler(get('http://localhost/usage?since=yesterday'));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/must be a number/);
  });

  it('405s a non-GET method and sets Allow', async () => {
    const handler = usageHandler({ source: () => [] });

    const response = await handler(new Request('http://localhost/usage', { method: 'POST' }));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('awaits an async source', async () => {
    const handler = usageHandler({
      source: async () => Promise.resolve([record({ attribution: { tenant: 'acme' } })]),
    });

    const report = (await (await handler(get('http://localhost/usage'))).json()) as UsageReport;

    expect(report.totals.count).toBe(1);
  });

  it('500s without throwing when the source fails', async () => {
    const handler = usageHandler({
      source: () => {
        throw new Error('redis down');
      },
    });

    const response = await handler(get('http://localhost/usage'));

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toMatch(/redis down/);
  });

  it('reports zero totals over an empty source', async () => {
    const handler = usageHandler({ source: () => [] });

    const report = (await (await handler(get('http://localhost/usage'))).json()) as UsageReport;

    expect(report.totals.count).toBe(0);
    expect(report.totals.cost).toBe(0);
  });
});
