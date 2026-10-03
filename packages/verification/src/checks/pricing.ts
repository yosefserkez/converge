import { numberField, postQuote } from '../app-client.ts';
import { CUSTOMER_IDS, type CustomerId, expectedUnitPrice, listPrice, PRODUCT_IDS, type ProductId } from '../expectations.ts';
import type { CheckImpl } from './context.ts';

/** Each customer on a fresh instance, so tier results do not depend on cache order. */
export const pricingTiers: CheckImpl = async ({ rec, pool, capabilities }) => {
  for (const customerId of CUSTOMER_IDS) {
    await pool.withFresh(async (app) => {
      for (const productId of PRODUCT_IDS) {
        const label = `${customerId} ${productId}`;
        const { response, json } = await postQuote(app, customerId, { productId, quantity: 1 });
        rec.equal(`${label} status`, 200, response.status);
        rec.equal(`${label} listPriceCents`, listPrice(productId), numberField(json, 'listPriceCents'));
        rec.equal(`${label} unitPriceCents`, expectedUnitPrice(productId, customerId, capabilities), numberField(json, 'unitPriceCents'));
      }
    });
  }
};

const SEQUENCES: readonly (readonly CustomerId[])[] = [
  ['member-1', 'regular-1'],
  ['regular-1', 'member-1'],
];

/**
 * The reproducer: two customers in one process, in both orders, each order in a
 * fresh process. A shared cache entry that ignores tier shows up as one
 * customer receiving the other's price.
 */
export const pricingIsolation: CheckImpl = async ({ rec, pool, capabilities }) => {
  const productId: ProductId = 'backpack';
  for (const [seqIndex, order] of SEQUENCES.entries()) {
    await pool.withFresh(async (app) => {
      for (const [stepIndex, customerId] of order.entries()) {
        const label = `seq${seqIndex + 1} step${stepIndex + 1} ${customerId} ${productId}`;
        const { response, json } = await postQuote(app, customerId, { productId, quantity: 1 });
        rec.equal(`${label} status`, 200, response.status);
        rec.equal(`${label} unitPriceCents`, expectedUnitPrice(productId, customerId, capabilities), numberField(json, 'unitPriceCents'));
      }
    });
  }
};

/** totalCents and savingsCents for quantities 1 and 3, both products, each customer on a fresh instance. */
export const quoteQuantity: CheckImpl = async ({ rec, pool, capabilities }) => {
  for (const customerId of CUSTOMER_IDS) {
    await pool.withFresh(async (app) => {
      for (const productId of PRODUCT_IDS) {
        for (const quantity of [1, 3]) {
          const label = `${customerId} ${productId} q${quantity}`;
          const unit = expectedUnitPrice(productId, customerId, capabilities);
          const { response, json } = await postQuote(app, customerId, { productId, quantity });
          rec.equal(`${label} status`, 200, response.status);
          rec.equal(`${label} quantity`, quantity, numberField(json, 'quantity'));
          rec.equal(`${label} unitPriceCents`, unit, numberField(json, 'unitPriceCents'));
          rec.equal(`${label} totalCents`, unit * quantity, numberField(json, 'totalCents'));
          rec.equal(`${label} savingsCents`, listPrice(productId) - unit, numberField(json, 'savingsCents'));
        }
      }
    });
  }
};
