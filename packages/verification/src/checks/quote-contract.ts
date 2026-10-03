import { z } from 'zod';
import { header, postQuote, postQuoteRaw, type QuoteCall } from '../app-client.ts';
import { EXPECTATIONS } from '../expectations.ts';
import type { Recorder } from '../recorder.ts';
import type { CheckImpl } from './context.ts';

const Cents = z.number().int().nonnegative();

/** Quote response version 1. Strict: unknown fields fail. */
export const QuoteV1 = z.strictObject({
  productId: z.string().min(1),
  listPriceCents: Cents,
  unitPriceCents: Cents,
  savingsCents: Cents,
  quantity: z.number().int().min(EXPECTATIONS.quantity.min).max(EXPECTATIONS.quantity.max),
  totalCents: Cents,
  currency: z.literal('USD'),
});

function schemaIssues(json: unknown): string[] {
  const parsed = QuoteV1.safeParse(json);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

function assertValidQuote(rec: Recorder, label: string, call: QuoteCall, productId: string, quantity: number): void {
  rec.equal(`${label} status`, 200, call.response.status);
  rec.check(`${label} content-type`, 'application/json', header(call.response, 'content-type'), header(call.response, 'content-type').startsWith('application/json'));
  rec.check(`${label} cache-control`, 'no-store', header(call.response, 'cache-control'), /\bno-store\b/.test(header(call.response, 'cache-control')));
  rec.equal(`${label} schema issues`, [], schemaIssues(call.json));
  const parsed = QuoteV1.safeParse(call.json);
  if (!parsed.success) return;
  const q = parsed.data;
  rec.equal(`${label} productId`, productId, q.productId);
  rec.equal(`${label} quantity`, quantity, q.quantity);
  rec.equal(`${label} totalCents = unitPriceCents * quantity`, q.unitPriceCents * q.quantity, q.totalCents);
  rec.equal(`${label} savingsCents = listPriceCents - unitPriceCents`, q.listPriceCents - q.unitPriceCents, q.savingsCents);
}

interface RejectionCase {
  label: string;
  customerId: string | null;
  body: string;
  status: number;
}

function rejectionCases(): RejectionCase[] {
  const { statuses } = EXPECTATIONS;
  const valid = (overrides: Record<string, unknown>) => JSON.stringify({ productId: 'backpack', quantity: 1, ...overrides });
  const oversize = JSON.stringify({ productId: 'backpack', quantity: 1, padding: 'x'.repeat(EXPECTATIONS.maxBodyBytes + 512) });
  return [
    { label: 'unknown product', customerId: 'regular-1', body: valid({ productId: 'spaceship' }), status: statuses.invalidInput },
    { label: 'missing customer', customerId: null, body: valid({}), status: statuses.unknownCustomer },
    { label: 'unknown customer', customerId: 'intruder-9', body: valid({}), status: statuses.unknownCustomer },
    { label: 'quantity 0', customerId: 'regular-1', body: valid({ quantity: 0 }), status: statuses.invalidInput },
    { label: 'quantity 21', customerId: 'regular-1', body: valid({ quantity: 21 }), status: statuses.invalidInput },
    { label: 'quantity 1.5', customerId: 'regular-1', body: valid({ quantity: 1.5 }), status: statuses.invalidInput },
    { label: 'quantity "2"', customerId: 'regular-1', body: valid({ quantity: '2' }), status: statuses.invalidInput },
    { label: 'quantity missing', customerId: 'regular-1', body: JSON.stringify({ productId: 'backpack' }), status: statuses.invalidInput },
    { label: 'body is an array', customerId: 'regular-1', body: '[]', status: statuses.invalidInput },
    { label: 'malformed JSON', customerId: 'regular-1', body: '{"productId":"backpack",', status: statuses.malformedJson },
    { label: 'body over 4 KiB', customerId: 'regular-1', body: oversize, status: statuses.bodyTooLarge },
  ];
}

export const quoteContract: CheckImpl = async ({ rec, pool }) => {
  await pool.withFresh(async (app) => {
    assertValidQuote(rec, 'valid regular-1 backpack q2', await postQuote(app, 'regular-1', { productId: 'backpack', quantity: 2 }), 'backpack', 2);
    assertValidQuote(rec, 'valid member-1 notebook q1', await postQuote(app, 'member-1', { productId: 'notebook', quantity: 1 }), 'notebook', 1);

    // A client-supplied price must have no effect. Regular customers always pay list price.
    const spoof = await postQuote(app, 'regular-1', {
      productId: 'backpack',
      quantity: 1,
      unitPriceCents: 1,
      listPriceCents: 1,
      totalCents: 1,
      price: 1,
    });
    rec.equal('client-supplied price ignored: status', 200, spoof.response.status);
    rec.equal(
      'client-supplied price ignored: regular-1 backpack unitPriceCents',
      EXPECTATIONS.products.backpack.listPriceCents,
      QuoteV1.safeParse(spoof.json).data?.unitPriceCents ?? null,
    );

    for (const c of rejectionCases()) {
      const call = await postQuoteRaw(app, c.customerId, c.body);
      rec.equal(`rejects ${c.label}: status`, c.status, call.response.status);
      rec.check(`rejects ${c.label}: cache-control`, 'no-store', header(call.response, 'cache-control'), /\bno-store\b/.test(header(call.response, 'cache-control')));
    }
  });
};
