import type { UnitPrice, UnitPriceFn, UnitPriceInput } from '../quote-contract';

/**
 * Wraps a unit-price function with an in-memory cache.
 *
 * The cache stores unit-price data only (never totals), so quantity does not
 * affect reuse. Catalog prices and membership state are fixed for the life of
 * the process, so entries never need invalidation.
 *
 * Cache key: every price-affecting dimension, productId and membershipTier.
 * Member pricing made the unit price depend on membershipTier, so a key of
 * productId alone served one tier's price to the other.
 */
export function unitPriceCacheKey({ productId, customer }: UnitPriceInput): string {
  return JSON.stringify([productId, customer.membershipTier]);
}

export function createUnitPriceCache(compute: UnitPriceFn): UnitPriceFn {
  const cache = new Map<string, UnitPrice>();
  return (input: UnitPriceInput): UnitPrice => {
    const key = unitPriceCacheKey(input);
    let price = cache.get(key);
    if (!price) {
      price = compute(input);
      cache.set(key, price);
    }
    return { ...price };
  };
}
