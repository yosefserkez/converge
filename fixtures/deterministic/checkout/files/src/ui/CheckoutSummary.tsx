import { useId } from 'react';
import type { Quote } from '../quote-contract';

export interface CheckoutSummaryProps {
  quote?: Quote | null;
  loading?: boolean;
  error?: string | null;
}

/** Formats integer cents as US dollars without floating-point arithmetic. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Price breakdown for one server quote. Every amount comes from the quote
 * response; the component never derives eligibility or a discount itself.
 */
export function CheckoutSummary({ quote, loading = false, error = null }: CheckoutSummaryProps) {
  const titleId = useId();
  if (loading) {
    return (
      <section className="checkout-summary" aria-labelledby={titleId} aria-busy="true">
        <h2 id={titleId}>Order summary</h2>
        <p role="status">Loading quote…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="checkout-summary" aria-labelledby={titleId}>
        <h2 id={titleId}>Order summary</h2>
        <p role="alert">{error}</p>
      </section>
    );
  }
  if (!quote) return null;
  const hasSavings = quote.savingsCents > 0;
  return (
    <section className="checkout-summary" aria-labelledby={titleId}>
      <h2 id={titleId}>Order summary</h2>
      <dl className="checkout-summary__lines">
        <div className="checkout-summary__line">
          <dt>List price</dt>
          <dd>{formatCents(quote.listPriceCents)}</dd>
        </div>
        {hasSavings ? (
          <div className="checkout-summary__line checkout-summary__line--savings">
            <dt>Member savings</dt>
            <dd>{formatCents(quote.savingsCents)} per item</dd>
          </div>
        ) : null}
        <div className="checkout-summary__line">
          <dt>Unit price</dt>
          <dd>{formatCents(quote.unitPriceCents)}</dd>
        </div>
        <div className="checkout-summary__line">
          <dt>Quantity</dt>
          <dd>{quote.quantity}</dd>
        </div>
        <div className="checkout-summary__line checkout-summary__line--total">
          <dt>Total</dt>
          <dd>{formatCents(quote.totalCents)}</dd>
        </div>
      </dl>
    </section>
  );
}
