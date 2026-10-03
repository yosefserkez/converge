import { describe, expect, it } from 'vitest';
import { commandScope, decideReceipt, DomainError, Id, newId, RepoName, repoNameFor, requestDigest } from '../src/index.ts';

describe('idempotency', () => {
  it('scopes by actor, project, and command without separator collisions', () => {
    expect(commandScope('alice', 'prj', 'session.create')).toBe('alice:prj:session.create');
    expect(commandScope('a:b', 'c', 'd')).not.toBe(commandScope('a', 'b:c', 'd'));
  });

  it('digests request bodies canonically', async () => {
    expect(await requestDigest({ a: 1, b: 2 })).toBe(await requestDigest({ b: 2, a: 1 }));
  });

  it('decides new, replay, and mismatch', async () => {
    const d1 = await requestDigest({ goal: 'x' });
    const d2 = await requestDigest({ goal: 'y' });
    expect(decideReceipt(null, d1)).toBe('new');
    expect(decideReceipt({ requestDigest: d1 }, d1)).toBe('replay');
    expect(decideReceipt({ requestDigest: d1 }, d2)).toBe('mismatch');
  });
});

describe('newId', () => {
  it('produces unique, valid lowercase ids', () => {
    const ids = Array.from({ length: 200 }, () => newId('ses'));
    expect(new Set(ids).size).toBe(200);
    for (const id of ids) {
      expect(Id.safeParse(id).success).toBe(true);
      expect(id).toMatch(/^ses_[a-z2-7]{26}$/);
    }
  });

  it('rejects bad prefixes', () => {
    expect(() => newId('Bad')).toThrow(DomainError);
    expect(() => newId('')).toThrow(DomainError);
  });
});

describe('repoNameFor', () => {
  it('is deterministic and valid', () => {
    const name = repoNameFor('proposal', 'ses_abc123', 'pricing');
    expect(name).toBe('cv-ses-abc123-p-pricing');
    expect(repoNameFor('proposal', 'ses_abc123', 'pricing')).toBe(name);
    expect(RepoName.safeParse(name).success).toBe(true);
  });

  it('sanitizes and shortens long names deterministically', () => {
    const session = newId('ses');
    const long = repoNameFor('candidate', session, 'Pricing + Caching + Checkout + Repair Attempt 2 for the final goal');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(RepoName.safeParse(long).success).toBe(true);
    expect(repoNameFor('candidate', session, 'Pricing + Caching + Checkout + Repair Attempt 2 for the final goal')).toBe(long);
    expect(repoNameFor('candidate', session, 'Pricing + Caching + Checkout + Repair Attempt 3 for the final goal')).not.toBe(long);
  });

  it('distinguishes kinds and rejects empty parts', () => {
    expect(repoNameFor('baseline', 'ses-1', 'main')).not.toBe(repoNameFor('candidate', 'ses-1', 'main'));
    expect(() => repoNameFor('proposal', '___', 'x')).toThrow(DomainError);
  });
});
