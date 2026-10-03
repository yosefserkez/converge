import { describe, expect, it, vi } from 'vitest';
import type { UnitPriceInput } from '../src/quote-contract';
import { createUnitPriceCache } from '../src/pricing/quote-cache';

const member = { customerId: 'member-1', membershipTier: 'member' as const };
const regular = { customerId: 'regular-1', membershipTier: 'regular' as const };
const listPrices: Record<string, number> = { backpack: 10000, notebook: 2500 };

function tierAwareCompute() {
  return vi.fn(({ productId, customer }: UnitPriceInput) => {
    const list = listPrices[productId] ?? 0;
    return { listPriceCents: list, unitPriceCents: customer.membershipTier === 'member' ? (list * 80) / 100 : list };
  });
}

describe('createUnitPriceCache', () => {
  it('computes each product and tier once', () => {
    const compute = tierAwareCompute();
    const getUnitPrice = createUnitPriceCache(compute);
    for (let i = 0; i < 3; i += 1) {
      expect(getUnitPrice({ productId: 'backpack', customer: regular }).unitPriceCents).toBe(10000);
    }
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('keeps member and regular prices separate in either order', () => {
    const memberFirst = createUnitPriceCache(tierAwareCompute());
    expect(memberFirst({ productId: 'backpack', customer: member }).unitPriceCents).toBe(8000);
    expect(memberFirst({ productId: 'backpack', customer: regular }).unitPriceCents).toBe(10000);

    const regularFirst = createUnitPriceCache(tierAwareCompute());
    expect(regularFirst({ productId: 'backpack', customer: regular }).unitPriceCents).toBe(10000);
    expect(regularFirst({ productId: 'backpack', customer: member }).unitPriceCents).toBe(8000);
  });

  it('keeps products separate', () => {
    const compute = tierAwareCompute();
    const getUnitPrice = createUnitPriceCache(compute);
    expect(getUnitPrice({ productId: 'backpack', customer: regular }).unitPriceCents).toBe(10000);
    expect(getUnitPrice({ productId: 'notebook', customer: regular }).unitPriceCents).toBe(2500);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('returns copies so callers cannot corrupt the cache', () => {
    const getUnitPrice = createUnitPriceCache(tierAwareCompute());
    const first = getUnitPrice({ productId: 'backpack', customer: regular });
    first.unitPriceCents = 1;
    expect(getUnitPrice({ productId: 'backpack', customer: regular }).unitPriceCents).toBe(10000);
  });
});
