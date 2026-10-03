// Locale-independent ordering helpers. Never use localeCompare for anything
// that feeds a digest or a deterministic plan.

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareNumbers(a: number, b: number): number {
  return a - b;
}

/** Sorted, deduplicated copy using code-unit order. */
export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}
