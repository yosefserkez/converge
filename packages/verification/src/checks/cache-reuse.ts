import { getComputeCount, numberField, postQuote } from '../app-client.ts';
import { CUSTOMER_IDS, EXPECTATIONS, expectedUnitPrice } from '../expectations.ts';
import type { CheckImpl } from './context.ts';

/**
 * Repeated equivalent quotes must reuse the computed unit price. The protected
 * compute counter wraps the pricing function outside the cache module:
 * - the first request for a new (product, tier) must compute exactly once, so a
 *   cache that skips the counted function is caught;
 * - repeats, including a different quantity, must not compute again, so a
 *   bypassed cache is caught.
 * Each customer runs on a fresh instance; cross-customer order is
 * pricing.isolation's job.
 */
export const cacheReuse: CheckImpl = async ({ rec, pool, capabilities }) => {
  for (const customerId of CUSTOMER_IDS) {
    await pool.withFresh(async (app) => {
      let before = await getComputeCount(app);
      rec.check(`${customerId} initial compute-count readable`, 'non-negative integer', before, before !== null);
      if (before === null) return;
      for (const [index, step] of EXPECTATIONS.cacheReuseSteps.entries()) {
        const label = `${customerId} step${index + 1} ${step.productId} q${step.quantity}`;
        const unit = expectedUnitPrice(step.productId, customerId, capabilities);
        const { response, json } = await postQuote(app, customerId, { productId: step.productId, quantity: step.quantity });
        rec.equal(`${label} status`, 200, response.status);
        rec.equal(`${label} unitPriceCents`, unit, numberField(json, 'unitPriceCents'));
        rec.equal(`${label} totalCents`, unit * step.quantity, numberField(json, 'totalCents'));
        const after = await getComputeCount(app);
        rec.equal(`${label} compute-count delta`, step.computeDelta, after === null ? null : after - before);
        if (after === null) return;
        before = after;
      }
    });
  }
};
