import { describe, expect, it } from 'vitest';
import type { MeterRecord } from '../src/index.js';
import {
  buildUsageReport,
  dashboardHandler,
  renderUsageDashboard,
} from '../src/index.js';

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

describe('renderUsageDashboard', () => {
  it('renders a self-contained HTML document', () => {
    const report = buildUsageReport([record({ attribution: { tenant: 'acme' } })]);

    const html = renderUsageDashboard(report);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<style>'); // styles inlined, no external assets
    expect(html).not.toContain('<script'); // no scripts
    expect(html).not.toMatch(/src=|href=/); // no external references
  });

  it('shows headline totals', () => {
    const report = buildUsageReport([
      record({ attribution: { tenant: 'acme' }, cost: 0.5 }),
      record({ attribution: { tenant: 'globex' }, cost: 0.25 }),
    ]);

    const html = renderUsageDashboard(report);

    expect(html).toContain('$0.7500'); // total spend (0.5 + 0.25)
    expect(html).toContain('Total spend');
    expect(html).toContain('Calls');
  });

  it('renders a table per dimension with cost-sorted rows', () => {
    const report = buildUsageReport(
      [
        record({ attribution: { tenant: 'acme' }, cost: 0.1 }),
        record({ attribution: { tenant: 'globex' }, cost: 0.9 }),
      ],
      { dimensions: ['tenant'] },
    );

    const html = renderUsageDashboard(report);

    expect(html).toContain('Tenant');
    expect(html).toContain('acme');
    expect(html).toContain('globex');
    // globex (0.9) outspends acme (0.1), so it leads in the cost-sorted rollup.
    expect(html.indexOf('globex')).toBeLessThan(html.indexOf('acme'));
  });

  it('only renders the dimensions present in the report', () => {
    const report = buildUsageReport([record()], { dimensions: ['feature'] });

    const html = renderUsageDashboard(report);

    expect(html).toContain('>Feature<');
    expect(html).not.toContain('>Tenant<');
    expect(html).not.toContain('>User<');
  });

  it('escapes HTML in dimension keys', () => {
    const report = buildUsageReport(
      [record({ attribution: { tenant: '<script>alert(1)</script>' } })],
      { dimensions: ['tenant'] },
    );

    const html = renderUsageDashboard(report);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders an empty state when a dimension has no spend', () => {
    const report = buildUsageReport([], { dimensions: ['tenant'] });

    const html = renderUsageDashboard(report);

    expect(html).toContain('No spend recorded');
    expect(html).toContain('$0.0000'); // zero totals still render
  });

  it('shows the window when bounded, and "all time" otherwise', () => {
    const all = renderUsageDashboard(buildUsageReport([record()]));
    expect(all).toContain('all time');

    const windowed = renderUsageDashboard(
      buildUsageReport([record()], { since: 0, until: 1_700_000_000_000 }),
    );
    expect(windowed).toContain('1970-01-01T00:00:00.000Z');
    expect(windowed).toContain('→');
  });

  it('honours a custom title in both the <title> and the header', () => {
    const html = renderUsageDashboard(buildUsageReport([record()]), {
      title: 'Acme spend',
    });

    expect(html).toContain('<title>Acme spend</title>');
    expect(html).toContain('<h1>Acme spend</h1>');
  });

  it('is deterministic for the same report', () => {
    const records = [record({ attribution: { tenant: 'acme' } })];
    expect(renderUsageDashboard(buildUsageReport(records))).toBe(
      renderUsageDashboard(buildUsageReport(records)),
    );
  });
});

describe('dashboardHandler', () => {
  it('returns HTML with a 200 and the right content type', async () => {
    const handler = dashboardHandler({
      source: () => [record({ attribution: { tenant: 'acme' } })],
    });

    const response = await handler(get('http://localhost/dashboard'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    const body = await response.text();
    expect(body).toContain('acme');
    expect(body.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('narrows to a single ?dimension=', async () => {
    const handler = dashboardHandler({
      source: () => [record({ attribution: { tenant: 'acme', feature: 'chat' } })],
    });

    const body = await (
      await handler(get('http://localhost/dashboard?dimension=tenant'))
    ).text();

    expect(body).toContain('>Tenant<');
    expect(body).not.toContain('>Feature<');
  });

  it('applies since/until window bounds from the query', async () => {
    const handler = dashboardHandler({
      source: () => [
        record({ timestamp: 100, attribution: { tenant: 'early' } }),
        record({ timestamp: 250, attribution: { tenant: 'mid' } }),
      ],
      dimensions: ['tenant'],
    });

    const body = await (
      await handler(get('http://localhost/dashboard?since=200&until=300'))
    ).text();

    expect(body).toContain('mid');
    expect(body).not.toContain('early');
  });

  it('renders an error page with a 400 on an unknown dimension', async () => {
    const handler = dashboardHandler({ source: () => [] });

    const response = await handler(get('http://localhost/dashboard?dimension=region'));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(await response.text()).toContain('unknown dimension');
  });

  it('405s a non-GET method and sets Allow', async () => {
    const handler = dashboardHandler({ source: () => [] });

    const response = await handler(
      new Request('http://localhost/dashboard', { method: 'POST' }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('awaits an async source', async () => {
    const handler = dashboardHandler({
      source: async () =>
        Promise.resolve([record({ attribution: { tenant: 'acme' } })]),
    });

    const body = await (await handler(get('http://localhost/dashboard'))).text();

    expect(body).toContain('acme');
  });

  it('500s without throwing when the source fails', async () => {
    const handler = dashboardHandler({
      source: () => {
        throw new Error('redis down');
      },
    });

    const response = await handler(get('http://localhost/dashboard'));

    expect(response.status).toBe(500);
    expect(await response.text()).toContain('redis down');
  });

  it('escapes a failing source message into the error page', async () => {
    const handler = dashboardHandler({
      source: () => {
        throw new Error('<img src=x onerror=alert(1)>');
      },
    });

    const body = await (await handler(get('http://localhost/dashboard'))).text();

    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;img src=x');
  });

  it('passes a configured title through to the page', async () => {
    const handler = dashboardHandler({ source: () => [record()], title: 'Ops view' });

    const body = await (await handler(get('http://localhost/dashboard'))).text();

    expect(body).toContain('<title>Ops view</title>');
  });
});
