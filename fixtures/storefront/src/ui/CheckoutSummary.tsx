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

export function CheckoutSummary({ quote, loading = false, error = null }: CheckoutSummaryProps) {
  if (loading) {
    return (
      <section className="checkout-summary" aria-busy="true">
        <p>Loading quote…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="checkout-summary">
        <p role="alert">{error}</p>
      </section>
    );
  }
  if (!quote) return null;
  return (
    <section className="checkout-summary">
      <h2>Order summary</h2>
      <p>Unit price: {formatCents(quote.unitPriceCents)}</p>
      <p>Total: {formatCents(quote.totalCents)}</p>
    </section>
  );
}
