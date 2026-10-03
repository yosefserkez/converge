import type { UnitPrice, UnitPriceFn, UnitPriceInput } from '../quote-contract';

/**
 * Wraps a unit-price function with an in-memory cache.
 *
 * The cache stores unit-price data only (never totals), so quantity does not
 * affect reuse. Catalog prices are fixed for the life of the process, so
 * entries never need invalidation.
 *
 * Cache key: productId. The unit price varies only by product.
 */
export function createUnitPriceCache(compute: UnitPriceFn): UnitPriceFn {
  const cache = new Map<string, UnitPrice>();
  return (input: UnitPriceInput): UnitPrice => {
    const key = input.productId;
    let price = cache.get(key);
    if (!price) {
      price = compute(input);
      cache.set(key, price);
    }
    return { ...price };
  };
}
