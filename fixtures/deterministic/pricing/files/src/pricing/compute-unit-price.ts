import type { UnitPrice, UnitPriceInput } from '../quote-contract';
import { getProduct } from '../products';

/** Percentage discount for customers whose membershipTier is "member". */
export const MEMBER_DISCOUNT_PERCENT = 20;

/**
 * Computes the unit price for one product and customer.
 *
 * Members receive MEMBER_DISCOUNT_PERCENT off list price. Regular customers pay
 * list price. All arithmetic stays in integer cents.
 * Price-affecting inputs: productId and customer.membershipTier.
 */
export function computeUnitPrice({ productId, customer }: UnitPriceInput): UnitPrice {
  const product = getProduct(productId);
  if (!product) throw new Error(`unknown product ${productId}`);
  const listPriceCents = product.listPriceCents;
  const unitPriceCents =
    customer.membershipTier === 'member'
      ? Math.round((listPriceCents * (100 - MEMBER_DISCOUNT_PERCENT)) / 100)
      : listPriceCents;
  return { listPriceCents, unitPriceCents };
}
