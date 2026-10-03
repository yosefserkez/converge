import { DomainError, RepoPath } from '@converge/domain';

const REF_COMPONENT = /^[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/;

/** A pattern ending in `/**` covers that directory; anything else is an exact path. */
export function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const dir = pattern.slice(0, -3);
    return filePath.startsWith(`${dir}/`);
  }
  return filePath === pattern;
}

export function matchesAny(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(filePath, p));
}

/** RepoPath plus a case-insensitive `.git` segment ban (case-folding filesystems). */
export function isSafeRepoPath(filePath: string): boolean {
  return RepoPath.safeParse(filePath).success && filePath.split('/').every((seg) => seg.toLowerCase() !== '.git');
}

export function assertRepoPath(filePath: string): void {
  if (!isSafeRepoPath(filePath)) {
    throw new DomainError('INVALID_INPUT', `invalid repository path: ${JSON.stringify(filePath.slice(0, 120))}`);
  }
}

/** Validates an edit path against the task scope. Protected wins over editable. */
export function assertEditable(filePath: string, editable: readonly string[], protectedPaths: readonly string[]): void {
  assertRepoPath(filePath);
  if (matchesAny(filePath, protectedPaths)) {
    throw new DomainError('PROTECTED_PATH', `edit touches protected path ${filePath}`, { path: filePath });
  }
  if (!matchesAny(filePath, editable)) {
    throw new DomainError('OUT_OF_SCOPE_EDIT', `edit outside permitted paths: ${filePath}`, { path: filePath });
  }
}

/**
 * Conservative branch-name check, stricter than `git check-ref-format`:
 * slash-separated components of [A-Za-z0-9._-], none starting with `.` or `-`,
 * no `..`, no `.lock` suffix.
 */
export function isValidBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch.length <= 200 &&
    !branch.includes('..') &&
    branch.split('/').every(
      (c) => REF_COMPONENT.test(c) && !c.startsWith('.') && !c.startsWith('-') && !c.endsWith('.lock') && !c.endsWith('.'),
    )
  );
}

export function assertBranch(branch: string): void {
  if (!isValidBranch(branch)) throw new DomainError('INVALID_INPUT', 'invalid branch name');
}

export function assertSha(sha: string): void {
  if (!SHA.test(sha)) throw new DomainError('INVALID_INPUT', 'invalid git object id');
}
