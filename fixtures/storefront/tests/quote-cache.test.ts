import { describe, expect, it, vi } from 'vitest';
import { createUnitPriceCache } from '../src/pricing/quote-cache';

const regular = { customerId: 'regular-1', membershipTier: 'regular' as const };

describe('createUnitPriceCache', () => {
  it('returns the computed unit price', () => {
    const compute = vi.fn(() => ({ listPriceCents: 10000, unitPriceCents: 10000 }));
    const getUnitPrice = createUnitPriceCache(compute);
    expect(getUnitPrice({ productId: 'backpack', customer: regular })).toEqual({ listPriceCents: 10000, unitPriceCents: 10000 });
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
