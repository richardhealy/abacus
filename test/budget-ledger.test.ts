import { describe, expect, it } from 'vitest';
import type { Budget } from '../src/index.js';
import {
  BudgetLedger,
  budgetLevel,
  evaluateBudget,
  InMemoryBudgetStore,
} from '../src/index.js';

const acmeBudget: Budget = {
  dimension: 'tenant',
  key: 'acme',
  window: 'monthly',
  soft: 5,
  hard: 10,
};

const chatBudget: Budget = {
  dimension: 'feature',
  key: 'chat',
  window: 'daily',
  hard: 2,
};

const JUN_27 = Date.UTC(2026, 5, 27);

describe('budgetLevel', () => {
  it('is ok below the soft limit', () => {
    expect(budgetLevel(acmeBudget, 4.99)).toBe('ok');
  });

  it('is soft at or above the soft limit but below hard', () => {
    expect(budgetLevel(acmeBudget, 5)).toBe('soft');
    expect(budgetLevel(acmeBudget, 9.99)).toBe('soft');
  });

  it('is hard at or above the hard limit', () => {
    expect(budgetLevel(acmeBudget, 10)).toBe('hard');
    expect(budgetLevel(acmeBudget, 100)).toBe('hard');
  });

  it('reports hard even when a soft limit is also crossed', () => {
    expect(budgetLevel(acmeBudget, 10)).toBe('hard');
  });

  it('treats a hard-only budget as ok until the hard limit', () => {
    expect(budgetLevel(chatBudget, 1.99)).toBe('ok');
    expect(budgetLevel(chatBudget, 2)).toBe('hard');
  });
});

describe('evaluateBudget', () => {
  it('pairs spend with level and fraction of the hard limit', () => {
    expect(evaluateBudget(acmeBudget, 5)).toEqual({
      budget: acmeBudget,
      spent: 5,
      level: 'soft',
      fraction: 0.5,
    });
  });
});

describe('BudgetLedger', () => {
  function ledger(budgets: Budget[], now = () => JUN_27) {
    return new BudgetLedger({ store: new InMemoryBudgetStore(), budgets, now });
  }

  it('matches budgets to an attribution by dimension value', () => {
    const l = ledger([acmeBudget, chatBudget]);
    expect(l.budgetsFor({ tenant: 'acme', feature: 'chat' })).toEqual([
      acmeBudget,
      chatBudget,
    ]);
    expect(l.budgetsFor({ tenant: 'globex' })).toEqual([]);
    expect(l.budgetsFor(undefined)).toEqual([]);
  });

  it('charges every matching budget and reports the resulting state', async () => {
    const l = ledger([acmeBudget, chatBudget]);
    // One call falls under both budgets at once, each in its own window.
    const states = await l.charge({ tenant: 'acme', feature: 'chat' }, 6);
    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({ spent: 6, level: 'soft' }); // acme soft=5 hard=10
    expect(states[1]).toMatchObject({ spent: 6, level: 'hard' }); // chat hard=2
  });

  it('accumulates across charges and crosses thresholds', async () => {
    const l = ledger([acmeBudget]);
    expect((await l.charge({ tenant: 'acme' }, 4))[0]).toMatchObject({
      spent: 4,
      level: 'ok',
    });
    expect((await l.charge({ tenant: 'acme' }, 2))[0]).toMatchObject({
      spent: 6,
      level: 'soft',
    });
    expect((await l.charge({ tenant: 'acme' }, 5))[0]).toMatchObject({
      spent: 11,
      level: 'hard',
    });
  });

  it('charges nothing for an unattributed call', async () => {
    const l = ledger([acmeBudget]);
    expect(await l.charge(undefined, 5)).toEqual([]);
    expect(await l.charge({ feature: 'chat' }, 5)).toEqual([]);
  });

  it('check reads current state without charging', async () => {
    const l = ledger([acmeBudget]);
    await l.charge({ tenant: 'acme' }, 3);
    const checked = await l.check({ tenant: 'acme' });
    expect(checked[0]).toMatchObject({ spent: 3, level: 'ok' });
    // checking again does not move the spend
    expect((await l.check({ tenant: 'acme' }))[0]).toMatchObject({ spent: 3 });
  });

  it('treats a zero-cost charge as a no-op read', async () => {
    const l = ledger([acmeBudget]);
    const states = await l.charge({ tenant: 'acme' }, 0);
    expect(states[0]).toMatchObject({ spent: 0, level: 'ok' });
  });

  it('places spend in the window chosen by its clock', async () => {
    const store = new InMemoryBudgetStore();
    const l = new BudgetLedger({
      store,
      budgets: [acmeBudget],
      now: () => JUN_27,
    });
    await l.charge({ tenant: 'acme' }, 7);
    // Same month, different instant → same bucket.
    expect(
      await store.getSpend(
        { dimension: 'tenant', key: 'acme', window: 'monthly' },
        Date.UTC(2026, 5, 1),
      ),
    ).toBe(7);
    // Different month → fresh bucket.
    expect(
      await store.getSpend(
        { dimension: 'tenant', key: 'acme', window: 'monthly' },
        Date.UTC(2026, 6, 1),
      ),
    ).toBe(0);
  });
});

describe('BudgetLedger budget validation', () => {
  function build(...budgets: Budget[]) {
    return () => new BudgetLedger({ store: new InMemoryBudgetStore(), budgets });
  }

  it('rejects a soft limit above the hard limit', () => {
    // Left alone, a soft limit of 20 under a hard limit of 10 is never
    // reported: spend reaches hard first, so a configured downshift or cache
    // rule would silently never run.
    const inverted: Budget = { ...acmeBudget, soft: 20, hard: 10 };
    expect(budgetLevel(inverted, 15)).toBe('hard');
    expect(build(inverted)).toThrow(RangeError);
    expect(build(inverted)).toThrow(
      'BudgetLedger: budget for tenant "acme" (monthly) has a soft limit of 20 above its hard limit of 10',
    );
  });

  it('rejects a hard limit that is negative or not a number', () => {
    // A NaN hard limit (say from Number(process.env.UNSET)) would never be
    // reached, so the budget would never refuse.
    expect(budgetLevel({ ...chatBudget, hard: Number.NaN }, 1_000_000)).toBe('ok');
    expect(build({ ...chatBudget, hard: Number.NaN })).toThrow(
      'BudgetLedger: budget for feature "chat" (daily) has a hard limit of NaN; limits must be numbers of 0 or more',
    );
    expect(build({ ...chatBudget, hard: -1 })).toThrow(RangeError);
  });

  it('rejects a soft limit that is negative or not a number', () => {
    expect(build({ ...acmeBudget, soft: Number.NaN })).toThrow(
      'BudgetLedger: budget for tenant "acme" (monthly) has a soft limit of NaN; limits must be numbers of 0 or more',
    );
    expect(build({ ...acmeBudget, soft: -5 })).toThrow(RangeError);
  });

  it('names the offending budget when several are configured', () => {
    expect(build(acmeBudget, { ...chatBudget, soft: 3 })).toThrow(
      'BudgetLedger: budget for feature "chat" (daily) has a soft limit of 3 above its hard limit of 2',
    );
  });

  it('accepts a soft limit equal to the hard limit, a zero hard limit and an unbounded hard limit', () => {
    expect(build({ ...acmeBudget, soft: 10, hard: 10 })).not.toThrow();
    // hard: 0 refuses all spend, which is a legitimate way to block a tenant.
    expect(build({ ...chatBudget, hard: 0 })).not.toThrow();
    // hard: Infinity degrades at soft but never refuses.
    expect(build({ ...acmeBudget, soft: 5, hard: Number.POSITIVE_INFINITY })).not.toThrow();
    expect(build(acmeBudget, chatBudget)).not.toThrow();
  });
});
