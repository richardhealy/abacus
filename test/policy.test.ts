import { describe, expect, it } from 'vitest';
import type { Budget, BudgetState, Policy } from '../src/index.js';
import {
  decide,
  describeBudgetState,
  mostSevere,
  resolveDownshift,
} from '../src/index.js';

const OPUS = 'anthropic/claude-opus-4';
const HAIKU = 'anthropic/claude-haiku-4';

const tenantBudget: Budget = {
  dimension: 'tenant',
  key: 'acme',
  window: 'monthly',
  soft: 5,
  hard: 10,
};

/** Build a budget state at a chosen spend, deriving level/fraction by hand. */
function state(
  level: BudgetState['level'],
  spent: number,
  budget: Budget = tenantBudget,
): BudgetState {
  return { budget, spent, level, fraction: spent / budget.hard };
}

const req = { modelId: OPUS };

describe('resolveDownshift', () => {
  it('resolves a fixed string target', () => {
    expect(resolveDownshift(HAIKU, OPUS)).toBe(HAIKU);
  });

  it('resolves a record map by the requested model id', () => {
    expect(resolveDownshift({ [OPUS]: HAIKU }, OPUS)).toBe(HAIKU);
  });

  it('returns undefined for a model absent from the map', () => {
    expect(resolveDownshift({ [OPUS]: HAIKU }, 'other/model')).toBeUndefined();
  });

  it('resolves a function target', () => {
    const fn = (id: string) => (id === OPUS ? HAIKU : undefined);
    expect(resolveDownshift(fn, OPUS)).toBe(HAIKU);
    expect(resolveDownshift(fn, 'other/model')).toBeUndefined();
  });

  it('treats a self-target as no downshift (never loops)', () => {
    expect(resolveDownshift(OPUS, OPUS)).toBeUndefined();
    expect(resolveDownshift({ [OPUS]: OPUS }, OPUS)).toBeUndefined();
  });
});

describe('mostSevere', () => {
  it('returns undefined for no budgets', () => {
    expect(mostSevere([])).toBeUndefined();
  });

  it('picks hard over soft over ok', () => {
    const states = [state('ok', 1), state('hard', 10), state('soft', 6)];
    expect(mostSevere(states)?.level).toBe('hard');
  });

  it('breaks ties at the same level by fraction consumed', () => {
    const a = state('soft', 6); // fraction 0.6
    const b = state('soft', 8); // fraction 0.8
    expect(mostSevere([a, b])).toBe(b);
  });
});

describe('decide — no degradation', () => {
  it('allows a call under no budgets', () => {
    expect(decide({}, [], req)).toEqual({ type: 'allow' });
  });

  it('allows when every budget is ok', () => {
    expect(decide({}, [state('ok', 1)], req)).toEqual({ type: 'allow' });
  });

  it('observes (allows) at the soft level by default', () => {
    // Default soft rule is allow: the operator must opt into degradation.
    expect(decide({}, [state('soft', 6)], req)).toEqual({ type: 'allow' });
  });

  it('refuses at the hard level by default', () => {
    const action = decide({}, [state('hard', 10)], req);
    expect(action).toMatchObject({ type: 'refuse', trigger: { level: 'hard' } });
  });
});

describe('decide — soft branch', () => {
  it('downshifts to a cheaper model on soft (string target)', () => {
    const policy: Policy = { soft: { kind: 'downshift', to: HAIKU } };
    const action = decide(policy, [state('soft', 6)], req);
    expect(action).toMatchObject({
      type: 'downshift',
      model: HAIKU,
      from: OPUS,
      trigger: { level: 'soft' },
    });
  });

  it('downshifts via a record map', () => {
    const policy: Policy = {
      soft: { kind: 'downshift', to: { [OPUS]: HAIKU } },
    };
    expect(decide(policy, [state('soft', 6)], req)).toMatchObject({
      type: 'downshift',
      model: HAIKU,
    });
  });

  it('serves cache on soft', () => {
    const policy: Policy = { soft: { kind: 'cache' } };
    expect(decide(policy, [state('soft', 6)], req)).toMatchObject({
      type: 'cache',
      trigger: { level: 'soft' },
    });
  });

  it('can refuse on soft when configured strictly', () => {
    const policy: Policy = { soft: { kind: 'refuse' } };
    expect(decide(policy, [state('soft', 6)], req)).toMatchObject({
      type: 'refuse',
    });
  });
});

describe('decide — downshift fallthrough (else)', () => {
  it('falls through to allow when no cheaper model resolves', () => {
    // Map has no entry for the requested model → default else is allow.
    const policy: Policy = {
      soft: { kind: 'downshift', to: { 'some/other': HAIKU } },
    };
    expect(decide(policy, [state('soft', 6)], req)).toEqual({ type: 'allow' });
  });

  it('applies an explicit else rule when downshift cannot resolve', () => {
    const policy: Policy = {
      hard: {
        kind: 'downshift',
        to: { 'some/other': HAIKU },
        else: { kind: 'refuse' },
      },
    };
    expect(decide(policy, [state('hard', 10)], req)).toMatchObject({
      type: 'refuse',
    });
  });

  it('does not downshift a model to itself; uses else', () => {
    const policy: Policy = {
      soft: { kind: 'downshift', to: OPUS, else: { kind: 'cache' } },
    };
    expect(decide(policy, [state('soft', 6)], req)).toMatchObject({
      type: 'cache',
    });
  });
});

describe('decide — hard branch', () => {
  it('refuses on hard with a descriptive reason', () => {
    const action = decide({}, [state('hard', 10)], req);
    expect(action).toMatchObject({ type: 'refuse' });
    if (action.type === 'refuse') {
      expect(action.reason).toContain("tenant 'acme'");
      expect(action.reason).toContain('hard limit');
    }
  });

  it('can downshift on hard when configured', () => {
    const policy: Policy = { hard: { kind: 'downshift', to: HAIKU } };
    expect(decide(policy, [state('hard', 10)], req)).toMatchObject({
      type: 'downshift',
      model: HAIKU,
    });
  });
});

describe('decide — most severe budget governs', () => {
  it('applies the hard rule when any budget is hard, even amid soft ones', () => {
    const feature: Budget = {
      dimension: 'feature',
      key: 'chat',
      window: 'daily',
      hard: 2,
    };
    const states = [state('soft', 6), state('hard', 2, feature)];
    const policy: Policy = {
      soft: { kind: 'cache' },
      hard: { kind: 'refuse' },
    };
    const action = decide(policy, states, req);
    expect(action).toMatchObject({ type: 'refuse' });
    if (action.type === 'refuse') {
      expect(action.trigger.budget).toBe(feature);
    }
  });
});

describe('reason overrides and descriptions', () => {
  it('uses a custom reason when the rule supplies one', () => {
    const policy: Policy = {
      hard: { kind: 'refuse', reason: 'Monthly budget exhausted — try later.' },
    };
    const action = decide(policy, [state('hard', 10)], req);
    expect(action).toMatchObject({
      type: 'refuse',
      reason: 'Monthly budget exhausted — try later.',
    });
  });

  it('describes a soft state against the soft limit', () => {
    expect(describeBudgetState(state('soft', 6))).toBe(
      "tenant 'acme' monthly budget at soft limit ($6.00 of $5.00)",
    );
  });

  it('describes a hard state against the hard limit', () => {
    expect(describeBudgetState(state('hard', 10))).toBe(
      "tenant 'acme' monthly budget at hard limit ($10.00 of $10.00)",
    );
  });
});
