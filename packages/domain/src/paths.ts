import { sortedUnique } from './order.ts';

/** Exact path match, or `dir/**` matching every path below `dir/`. */
export function matchesPattern(pattern: string, path: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -2); // keeps the trailing slash
    return path.startsWith(prefix) && path.length > prefix.length;
  }
  return pattern === path;
}

export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchesPattern(p, path));
}

export interface EditClassification {
  /** Changed, not protected, and outside every editable pattern: reject. */
  outOfScope: string[];
  /** Changed and protected (protected wins over editable): reject. */
  protectedViolations: string[];
  /** Changed but not declared in intent.affectedPaths: warning + extra validation. */
  undeclared: string[];
  /** Declared but not present in the diff: informational. */
  declaredButUnchanged: string[];
}

export function classifyEdits(input: {
  changedPaths: readonly string[];
  editablePaths: readonly string[];
  protectedPaths: readonly string[];
  declaredPaths: readonly string[];
}): EditClassification {
  const changed = sortedUnique(input.changedPaths);
  const protectedViolations = changed.filter((p) => matchesAny(input.protectedPaths, p));
  const outOfScope = changed.filter(
    (p) => !matchesAny(input.protectedPaths, p) && !matchesAny(input.editablePaths, p),
  );
  const undeclared = changed.filter((p) => !matchesAny(input.declaredPaths, p));
  const declaredButUnchanged = sortedUnique(input.declaredPaths).filter(
    (d) => !changed.some((p) => matchesPattern(d, p)),
  );
  return { outOfScope, protectedViolations, undeclared, declaredButUnchanged };
}
