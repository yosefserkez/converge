import { describe, expect, it } from 'vitest';
import { computeUnitPrice } from '../src/pricing/compute-unit-price';

const member = { customerId: 'member-1', membershipTier: 'member' as const };
const regular = { customerId: 'regular-1', membershipTier: 'regular' as const };

describe('computeUnitPrice', () => {
  it('charges list price to every customer', () => {
    expect(computeUnitPrice({ productId: 'backpack', customer: member })).toEqual({ listPriceCents: 10000, unitPriceCents: 10000 });
    expect(computeUnitPrice({ productId: 'backpack', customer: regular })).toEqual({ listPriceCents: 10000, unitPriceCents: 10000 });
    expect(computeUnitPrice({ productId: 'notebook', customer: regular })).toEqual({ listPriceCents: 2500, unitPriceCents: 2500 });
  });

  it('rejects unknown products', () => {
    expect(() => computeUnitPrice({ productId: 'spaceship', customer: regular })).toThrow();
  });
});
