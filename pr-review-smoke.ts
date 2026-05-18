// Temporary fixture for verifying the PR Review workflow end to end.
// This file is intentionally throwaway — the PR that adds it is a smoke
// test and should be closed, not merged.

/** Returns the arithmetic mean of the given numbers. */
export function average(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/** Returns the most recent entry in a history list. */
export function latest<T>(history: T[]): T {
  return history[history.length];
}
