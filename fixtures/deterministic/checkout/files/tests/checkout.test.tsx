import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckoutSummary, formatCents } from '../src/ui/CheckoutSummary';

const memberQuote = {
  productId: 'backpack',
  listPriceCents: 10000,
  unitPriceCents: 8000,
  savingsCents: 2000,
  quantity: 3,
  totalCents: 24000,
  currency: 'USD' as const,
};
const regularQuote = { ...memberQuote, unitPriceCents: 10000, savingsCents: 0, totalCents: 30000 };

describe('CheckoutSummary', () => {
  it('formats integer cents', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(2005)).toBe('$20.05');
    expect(formatCents(250005)).toBe('$2,500.05');
  });

  it('shows the full breakdown with member savings', () => {
    const html = renderToStaticMarkup(<CheckoutSummary quote={memberQuote} />);
    expect(html).toContain('<dt>List price</dt><dd>$100.00</dd>');
    expect(html).toContain('<dt>Member savings</dt><dd>$20.00 per item</dd>');
    expect(html).toContain('<dt>Unit price</dt><dd>$80.00</dd>');
    expect(html).toContain('<dt>Quantity</dt><dd>3</dd>');
    expect(html).toContain('<dt>Total</dt><dd>$240.00</dd>');
  });

  it('hides savings when there are none', () => {
    const html = renderToStaticMarkup(<CheckoutSummary quote={regularQuote} />);
    expect(html).not.toContain('savings');
    expect(html).toContain('<dt>Total</dt><dd>$300.00</dd>');
  });

  it('labels the summary region', () => {
    const html = renderToStaticMarkup(<CheckoutSummary quote={regularQuote} />);
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
  });

  it('shows loading and error states', () => {
    expect(renderToStaticMarkup(<CheckoutSummary loading />)).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<CheckoutSummary error="Quote request failed" />)).toContain('role="alert"');
  });
});
