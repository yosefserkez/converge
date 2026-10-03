import { describe, expect, it } from 'vitest';
import { classifyEdits, matchesPattern, PROTECTED_PATHS } from '../src/index.ts';

describe('matchesPattern', () => {
  it('matches exact paths', () => {
    expect(matchesPattern('src/a.ts', 'src/a.ts')).toBe(true);
    expect(matchesPattern('src/a.ts', 'src/a.tsx')).toBe(false);
  });

  it('matches dir/** as a prefix, not the dir itself or a sibling', () => {
    expect(matchesPattern('public/**', 'public/index.html')).toBe(true);
    expect(matchesPattern('public/**', 'public/a/b.css')).toBe(true);
    expect(matchesPattern('public/**', 'public')).toBe(false);
    expect(matchesPattern('public/**', 'publicity/x')).toBe(false);
  });
});

describe('classifyEdits', () => {
  it('separates out-of-scope, protected, undeclared, and declared-but-unchanged', () => {
    const result = classifyEdits({
      changedPaths: ['src/pricing/quote-cache.ts', 'src/server.ts', 'src/other.ts', 'tests/quote-cache.test.ts', 'public/x.js'],
      editablePaths: ['src/pricing/quote-cache.ts', 'tests/quote-cache.test.ts', 'src/server.ts'],
      protectedPaths: PROTECTED_PATHS,
      declaredPaths: ['src/pricing/quote-cache.ts', 'src/pricing/notes.md'],
    });
    expect(result).toEqual({
      outOfScope: ['src/other.ts'],
      protectedViolations: ['public/x.js', 'src/server.ts'],
      undeclared: ['public/x.js', 'src/other.ts', 'src/server.ts', 'tests/quote-cache.test.ts'],
      declaredButUnchanged: ['src/pricing/notes.md'],
    });
  });

  it('is clean for a well-scoped, declared edit', () => {
    expect(
      classifyEdits({
        changedPaths: ['src/ui/CheckoutSummary.tsx'],
        editablePaths: ['src/ui/**'],
        protectedPaths: PROTECTED_PATHS,
        declaredPaths: ['src/ui/CheckoutSummary.tsx'],
      }),
    ).toEqual({ outOfScope: [], protectedViolations: [], undeclared: [], declaredButUnchanged: [] });
  });
});
