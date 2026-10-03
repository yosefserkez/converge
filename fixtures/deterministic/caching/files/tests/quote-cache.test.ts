import { describe, expect, it, vi } from 'vitest';
import { createUnitPriceCache } from '../src/pricing/quote-cache';

const regular = { customerId: 'regular-1', membershipTier: 'regular' as const };
const listPrices: Record<string, number> = { backpack: 10000, notebook: 2500 };

function fakeCompute() {
  return vi.fn(({ productId }: { productId: string }) => {
    const cents = listPrices[productId] ?? 0;
    return { listPriceCents: cents, unitPriceCents: cents };
  });
}

describe('createUnitPriceCache', () => {
  it('computes each product once', () => {
    const compute = fakeCompute();
    const getUnitPrice = createUnitPriceCache(compute);
    for (let i = 0; i < 3; i += 1) {
      expect(getUnitPrice({ productId: 'backpack', customer: regular })).toEqual({ listPriceCents: 10000, unitPriceCents: 10000 });
    }
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('keeps products separate', () => {
    const compute = fakeCompute();
    const getUnitPrice = createUnitPriceCache(compute);
    expect(getUnitPrice({ productId: 'backpack', customer: regular }).unitPriceCents).toBe(10000);
    expect(getUnitPrice({ productId: 'notebook', customer: regular }).unitPriceCents).toBe(2500);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('returns copies so callers cannot corrupt the cache', () => {
    const getUnitPrice = createUnitPriceCache(fakeCompute());
    const first = getUnitPrice({ productId: 'backpack', customer: regular });
    first.unitPriceCents = 1;
    expect(getUnitPrice({ productId: 'backpack', customer: regular }).unitPriceCents).toBe(10000);
  });
});
