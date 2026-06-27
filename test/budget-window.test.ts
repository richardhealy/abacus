import { describe, expect, it } from 'vitest';
import { windowExpirySeconds, windowKey } from '../src/index.js';

const DAY = 86_400;

describe('windowKey', () => {
  it('buckets monthly spend by UTC calendar month', () => {
    expect(windowKey('monthly', Date.UTC(2026, 5, 27, 13, 30))).toBe('2026-06');
    expect(windowKey('monthly', Date.UTC(2026, 0, 1))).toBe('2026-01');
  });

  it('buckets daily spend by UTC calendar day', () => {
    expect(windowKey('daily', Date.UTC(2026, 5, 27, 23, 59))).toBe('2026-06-27');
    expect(windowKey('daily', Date.UTC(2026, 11, 9, 0, 0))).toBe('2026-12-09');
  });

  it('gives the same key everywhere within a window and a new one across it', () => {
    const morning = Date.UTC(2026, 5, 27, 1);
    const night = Date.UTC(2026, 5, 27, 23);
    const nextDay = Date.UTC(2026, 5, 28, 0);
    expect(windowKey('daily', morning)).toBe(windowKey('daily', night));
    expect(windowKey('daily', nextDay)).not.toBe(windowKey('daily', morning));
  });
});

describe('windowExpirySeconds', () => {
  it('returns a full day at the start of a daily window', () => {
    expect(windowExpirySeconds('daily', Date.UTC(2026, 5, 27))).toBe(DAY);
  });

  it('counts down to the next UTC midnight within a daily window', () => {
    expect(windowExpirySeconds('daily', Date.UTC(2026, 5, 27, 23))).toBe(3_600);
  });

  it('rounds partial seconds up so a bucket never expires early', () => {
    expect(
      windowExpirySeconds('daily', Date.UTC(2026, 5, 27, 23, 59, 59, 500)),
    ).toBe(1);
  });

  it('returns the whole month at the start of a monthly window', () => {
    // June has 30 days.
    expect(windowExpirySeconds('monthly', Date.UTC(2026, 5, 1))).toBe(30 * DAY);
  });

  it('rolls a December monthly window into the next year', () => {
    // December has 31 days; the boundary is Jan 1 of the next year.
    expect(windowExpirySeconds('monthly', Date.UTC(2026, 11, 1))).toBe(31 * DAY);
  });
});
