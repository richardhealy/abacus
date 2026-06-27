import { describe, expect, it } from 'vitest';
import type { Attribution, MeterRecord } from '../src/index.js';
import {
  attributionFromProviderOptions,
  mergeAttribution,
  rollupByDimension,
  UNATTRIBUTED_KEY,
} from '../src/index.js';

describe('attributionFromProviderOptions', () => {
  it('reads tenant / feature / user from the abacus namespace', () => {
    expect(
      attributionFromProviderOptions({
        abacus: { tenant: 'acme', feature: 'chat', user: 'u_1' },
      }),
    ).toEqual<Attribution>({ tenant: 'acme', feature: 'chat', user: 'u_1' });
  });

  it('reads string tags alongside the named dimensions', () => {
    expect(
      attributionFromProviderOptions({
        abacus: { tenant: 'acme', tags: { env: 'prod', region: 'eu' } },
      }),
    ).toEqual<Attribution>({ tenant: 'acme', tags: { env: 'prod', region: 'eu' } });
  });

  it('returns undefined when no abacus namespace is present', () => {
    expect(attributionFromProviderOptions(undefined)).toBeUndefined();
    expect(attributionFromProviderOptions({})).toBeUndefined();
    expect(attributionFromProviderOptions({ openai: { user: 'x' } })).toBeUndefined();
  });

  it('ignores non-string dimension values rather than throwing', () => {
    expect(
      attributionFromProviderOptions({
        // tenant is a number, user is null — both dropped; feature survives.
        abacus: { tenant: 42, feature: 'chat', user: null },
      }),
    ).toEqual<Attribution>({ feature: 'chat' });
  });

  it('drops non-string tag values but keeps the string ones', () => {
    expect(
      attributionFromProviderOptions({
        abacus: { tags: { env: 'prod', count: 3 } },
      }),
    ).toEqual<Attribution>({ tags: { env: 'prod' } });
  });

  it('returns undefined when the namespace has nothing usable', () => {
    expect(attributionFromProviderOptions({ abacus: {} })).toBeUndefined();
    expect(attributionFromProviderOptions({ abacus: { tenant: 7 } })).toBeUndefined();
    expect(attributionFromProviderOptions({ abacus: { tags: { n: 1 } } })).toBeUndefined();
  });
});

describe('mergeAttribution', () => {
  it('returns the other side when one is undefined', () => {
    const a: Attribution = { tenant: 'acme' };
    expect(mergeAttribution(a, undefined)).toBe(a);
    expect(mergeAttribution(undefined, a)).toBe(a);
    expect(mergeAttribution(undefined, undefined)).toBeUndefined();
  });

  it('lets per-call values win field by field while keeping base fields', () => {
    expect(
      mergeAttribution(
        { feature: 'chat', tenant: 'default' },
        { tenant: 'acme', user: 'u_1' },
      ),
    ).toEqual<Attribution>({ tenant: 'acme', feature: 'chat', user: 'u_1' });
  });

  it('shallow-merges tags with override keys winning', () => {
    expect(
      mergeAttribution(
        { tags: { env: 'dev', region: 'eu' } },
        { tags: { env: 'prod' } },
      ),
    ).toEqual<Attribution>({ tags: { env: 'prod', region: 'eu' } });
  });
});

function record(
  attribution: Attribution | undefined,
  cost: number,
  tokens = 10,
): MeterRecord {
  return {
    modelId: 'mock/opus',
    provider: 'mock',
    timestamp: 0,
    latencyMs: 1,
    usage: {
      inputTokens: tokens,
      outputTokens: tokens,
      totalTokens: tokens * 2,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
    ...(attribution ? { attribution } : {}),
    cost,
  };
}

describe('rollupByDimension', () => {
  it('groups by the dimension and sums usage and cost', () => {
    const records = [
      record({ tenant: 'acme' }, 0.5),
      record({ tenant: 'acme' }, 0.25),
      record({ tenant: 'globex' }, 1),
    ];

    const byTenant = rollupByDimension(records, 'tenant');

    expect(byTenant).toHaveLength(2);
    // Sorted by cost descending: globex (1) before acme (0.75).
    expect(byTenant[0]).toEqual({
      key: 'globex',
      count: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
      cost: 1,
    });
    expect(byTenant[1]).toMatchObject({ key: 'acme', count: 2, cost: 0.75 });
    expect(byTenant[1]?.usage.totalTokens).toBe(40);
  });

  it('collects records missing the dimension under the unattributed key', () => {
    const records = [
      record({ tenant: 'acme', feature: 'chat' }, 1),
      record({ tenant: 'acme' }, 2),
      record(undefined, 3),
    ];

    const byFeature = rollupByDimension(records, 'feature');

    expect(byFeature[0]).toMatchObject({ key: UNATTRIBUTED_KEY, count: 2, cost: 5 });
    expect(byFeature[1]).toMatchObject({ key: 'chat', count: 1, cost: 1 });
  });

  it('treats records without a cost as contributing zero', () => {
    const noCost: MeterRecord = {
      modelId: 'm',
      provider: 'p',
      timestamp: 0,
      latencyMs: 0,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
      attribution: { tenant: 'acme' },
    };

    expect(rollupByDimension([noCost], 'tenant')).toEqual([
      {
        key: 'acme',
        count: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
        cost: 0,
      },
    ]);
  });

  it('rounds summed cost to nano-dollar precision', () => {
    const records = [
      record({ tenant: 'acme' }, 0.1),
      record({ tenant: 'acme' }, 0.2),
    ];
    // 0.1 + 0.2 = 0.30000000000000004 in float; rollup rounds it to 0.3.
    expect(rollupByDimension(records, 'tenant')[0]?.cost).toBe(0.3);
  });

  it('supports a custom unattributed key', () => {
    const rolled = rollupByDimension([record(undefined, 1)], 'tenant', {
      unattributedKey: 'none',
    });
    expect(rolled[0]?.key).toBe('none');
  });
});
