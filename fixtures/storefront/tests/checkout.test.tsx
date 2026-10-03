import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckoutSummary, formatCents } from '../src/ui/CheckoutSummary';

const quote = {
  productId: 'backpack',
  listPriceCents: 10000,
  unitPriceCents: 10000,
  savingsCents: 0,
  quantity: 3,
  totalCents: 30000,
  currency: 'USD' as const,
};

describe('CheckoutSummary', () => {
  it('formats integer cents', () => {
    expect(formatCents(10000)).toBe('$100.00');
    expect(formatCents(250005)).toBe('$2,500.05');
  });

  it('shows unit price and total', () => {
    const html = renderToStaticMarkup(<CheckoutSummary quote={quote} />);
    expect(html).toContain('$100.00');
    expect(html).toContain('$300.00');
  });

  it('shows loading and error states', () => {
    expect(renderToStaticMarkup(<CheckoutSummary loading />)).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<CheckoutSummary error="Quote request failed" />)).toContain('role="alert"');
  });
});
