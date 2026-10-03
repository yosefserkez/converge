import { describe, expect, it } from 'vitest';
import { computeUnitPrice, MEMBER_DISCOUNT_PERCENT } from '../src/pricing/compute-unit-price';

const member = { customerId: 'member-1', membershipTier: 'member' as const };
const regular = { customerId: 'regular-1', membershipTier: 'regular' as const };

describe('computeUnitPrice', () => {
  it('gives members 20% off', () => {
    expect(MEMBER_DISCOUNT_PERCENT).toBe(20);
    expect(computeUnitPrice({ productId: 'backpack', customer: member })).toEqual({ listPriceCents: 10000, unitPriceCents: 8000 });
    expect(computeUnitPrice({ productId: 'notebook', customer: member })).toEqual({ listPriceCents: 2500, unitPriceCents: 2000 });
  });

  it('keeps regular customers at list price', () => {
    expect(computeUnitPrice({ productId: 'backpack', customer: regular })).toEqual({ listPriceCents: 10000, unitPriceCents: 10000 });
    expect(computeUnitPrice({ productId: 'notebook', customer: regular })).toEqual({ listPriceCents: 2500, unitPriceCents: 2500 });
  });

  it('returns integer cents', () => {
    for (const productId of ['backpack', 'notebook']) {
      for (const customer of [member, regular]) {
        const price = computeUnitPrice({ productId, customer });
        expect(Number.isInteger(price.unitPriceCents)).toBe(true);
      }
    }
  });

  it('rejects unknown products', () => {
    expect(() => computeUnitPrice({ productId: 'spaceship', customer: regular })).toThrow();
  });
});
