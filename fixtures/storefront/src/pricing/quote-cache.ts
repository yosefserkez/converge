import type { UnitPriceFn } from '../quote-contract';

/**
 * Wraps a unit-price function with a cache.
 *
 * Baseline: no caching. Every call reaches the underlying computation.
 */
export function createUnitPriceCache(compute: UnitPriceFn): UnitPriceFn {
  return (input) => compute(input);
}
