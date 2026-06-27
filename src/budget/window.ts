import type { BudgetWindow } from './types.js';

/**
 * Windowing math for budgets — pure, deterministic, and UTC-based.
 *
 * Every budget window is bucketed by a string key derived from a timestamp. All
 * boundaries are computed in UTC so a window rolls over at the same instant for
 * every caller regardless of server timezone; this is what makes spend
 * accounting reproducible and free of daylight-saving surprises.
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The bucket key for the window containing `at` (epoch milliseconds).
 *
 * - `'daily'`   → `"YYYY-MM-DD"` (UTC calendar day).
 * - `'monthly'` → `"YYYY-MM"` (UTC calendar month).
 *
 * Two timestamps in the same window produce the same key; the first instant of
 * the next window produces a new one, which is how spend resets at a window
 * boundary without any scheduled job.
 */
export function windowKey(window: BudgetWindow, at: number): string {
  const d = new Date(at);
  const year = d.getUTCFullYear();
  const month = pad2(d.getUTCMonth() + 1);
  if (window === 'monthly') return `${year}-${month}`;
  return `${year}-${month}-${pad2(d.getUTCDate())}`;
}

/**
 * Seconds from `at` until the current window ends (the first instant of the next
 * window), rounded up so the value never expires the bucket early.
 *
 * Used as the TTL for a durable store's window bucket: a key set to expire at
 * the window boundary cleans itself up and guarantees a fresh count in the next
 * window even if nothing reads it. Setting it on every write is safe — the
 * boundary is fixed for the window, so re-deriving the TTL mid-window always
 * points at the same instant.
 */
export function windowExpirySeconds(window: BudgetWindow, at: number): number {
  const d = new Date(at);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const end =
    window === 'monthly'
      ? Date.UTC(year, month + 1, 1)
      : Date.UTC(year, month, d.getUTCDate() + 1);
  return Math.ceil((end - at) / 1000);
}
