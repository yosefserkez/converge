import { PROTECTED_PATHS, STOREFRONT_TASKS } from '@converge/domain';
import { describe, expect, it } from 'vitest';
import { loadFixturePatch, loadStorefrontBaseline } from '../src/fixture-patches.ts';
import { FIXTURE_ROLES, isProtectedPath, parseFixtureManifest } from '../src/patch-manifest.ts';

describe('deterministic fixture patches', () => {
  it.each(FIXTURE_ROLES)('%s loads, validates, and stays inside editable paths', async (role) => {
    const patch = await loadFixturePatch(role);
    expect(patch.role).toBe(role);
    expect(patch.summary.length).toBeGreaterThan(0);
    const task = STOREFRONT_TASKS.find((t) => t.role === (role === 'repair' ? 'caching' : role));
    for (const [path, content] of Object.entries(patch.files)) {
      expect(isProtectedPath(path)).toBe(false);
      expect(task?.editablePaths).toContain(path);
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('pricing declares the new pricing dimension and discount', async () => {
    const { intent } = await loadFixturePatch('pricing');
    expect(intent.contractChanges).toContainEqual(expect.objectContaining({ key: 'unit-price.dimensions', before: ['productId'], after: ['productId', 'membershipTier'] }));
    expect(intent.contractChanges).toContainEqual(expect.objectContaining({ key: 'membership.discount-percent', before: 0, after: 20 }));
  });

  it('caching assumes product-only dimensions; repair widens them', async () => {
    const caching = await loadFixturePatch('caching');
    expect(caching.intent.assumptions).toContainEqual({
      key: 'unit-price.dimensions',
      operator: 'subset_of',
      expected: ['productId'],
      rationale: 'The cache key varies only by product.',
    });
    const repair = await loadFixturePatch('repair');
    expect(Object.keys(repair.files).sort()).toEqual(['src/pricing/quote-cache.ts', 'tests/quote-cache.test.ts']);
    expect(repair.intent.assumptions).toContainEqual(expect.objectContaining({ key: 'unit-price.dimensions', operator: 'subset_of', expected: ['productId', 'membershipTier'] }));
  });

  it('rejects a manifest that edits a protected path', () => {
    expect(() =>
      parseFixtureManifest({
        role: 'pricing',
        taskId: 'task-pricing',
        summary: 's',
        files: { 'src/server.ts': 'files/src/server.ts' },
        intent: {
          schemaVersion: 1,
          objective: 'o',
          reads: [],
          writes: [],
          affectedPaths: ['src/server.ts'],
          assumptions: [],
          contractChanges: [],
          preservedInvariants: [],
          proposedCheckIds: [],
          dependencyRevisionIds: [],
        },
      }),
    ).toThrow(/protected/);
  });
});

describe('storefront baseline', () => {
  it('contains every protected file and no build output', async () => {
    const files = await loadStorefrontBaseline();
    for (const pattern of PROTECTED_PATHS) {
      if (pattern.endsWith('/**')) expect(Object.keys(files).some((p) => p.startsWith(pattern.slice(0, -2)))).toBe(true);
      else expect(files[pattern], pattern).toBeDefined();
    }
    expect(Object.keys(files).some((p) => p.startsWith('node_modules/') || p.startsWith('dist/'))).toBe(false);
  });
});
