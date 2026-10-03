import type { UnitPrice, UnitPriceInput } from '../quote-contract';
import { getProduct } from '../products';

/**
 * Computes the unit price for one product and customer.
 *
 * Baseline: the function accepts the customer context (with membershipTier),
 * but the context does not change the price. Every customer pays list price.
 */
export function computeUnitPrice({ productId }: UnitPriceInput): UnitPrice {
  const product = getProduct(productId);
  if (!product) throw new Error(`unknown product ${productId}`);
  return { listPriceCents: product.listPriceCents, unitPriceCents: product.listPriceCents };
}
