import { cacheReuse } from './cache-reuse.ts';
import { checkoutSummary } from './checkout-summary.ts';
import type { CheckImpl } from './context.ts';
import { pricingIsolation, pricingTiers, quoteQuantity } from './pricing.ts';
import { quoteContract } from './quote-contract.ts';

/** Implementation for each catalog check ID. */
export const CHECK_IMPLEMENTATIONS: Readonly<Record<string, CheckImpl>> = {
  'quote.contract': quoteContract,
  'pricing.tiers': pricingTiers,
  'pricing.isolation': pricingIsolation,
  'quote.quantity': quoteQuantity,
  'cache.reuse': cacheReuse,
  'checkout.summary': checkoutSummary,
};

export type { CheckContext, CheckImpl } from './context.ts';
