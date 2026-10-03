import type { ChangeIntent, RevisionRef } from '../src/index.ts';

export const sha = (c: string): string => c.repeat(40).slice(0, 40);
export const dg = (c: string): string => `sha256:${c.repeat(64).slice(0, 64)}`;

export function intent(partial: Partial<ChangeIntent> = {}): ChangeIntent {
  return {
    schemaVersion: 1,
    objective: 'test objective',
    reads: [],
    writes: [],
    affectedPaths: [],
    assumptions: [],
    contractChanges: [],
    preservedInvariants: [],
    proposedCheckIds: [],
    dependencyRevisionIds: [],
    ...partial,
  };
}

export const pricingIntent = intent({
  affectedPaths: ['src/pricing/compute-unit-price.ts'],
  contractChanges: [
    {
      key: 'unit-price.dimensions',
      before: ['productId'],
      after: ['productId', 'membershipTier'],
      explanation: 'Member status changes the unit price.',
    },
  ],
});

export const cachingIntent = intent({
  affectedPaths: ['src/pricing/quote-cache.ts'],
  assumptions: [
    {
      key: 'unit-price.dimensions',
      operator: 'subset_of',
      expected: ['productId'],
      rationale: 'The cache key varies only by product.',
    },
  ],
});

export const repairedCachingIntent = intent({
  affectedPaths: ['src/pricing/quote-cache.ts'],
  assumptions: [
    {
      key: 'unit-price.dimensions',
      operator: 'subset_of',
      expected: ['productId', 'membershipTier'],
      rationale: 'The cache key includes product and membership tier.',
    },
  ],
});

export const checkoutIntent = intent({ affectedPaths: ['src/ui/CheckoutSummary.tsx'] });

export function rev(
  revisionId: string,
  ordinal: number,
  deps: string[] = [],
  baseSha: string = sha('a'),
): RevisionRef & { ordinal: number } {
  return {
    revisionId,
    proposalId: `prop-${revisionId}`,
    repoName: `cv-ses-p-${revisionId}`,
    baseSha,
    headSha: sha('b'),
    treeSha: sha('c'),
    intentDigest: dg('d'),
    dependencyRevisionIds: deps,
    ordinal,
  };
}
