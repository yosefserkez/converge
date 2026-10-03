// Protected server-side rendering helper. The verification harness reads this
// HTML over HTTP to check the checkout summary without a browser.
import { renderToStaticMarkup } from 'react-dom/server';
import type { Quote } from './quote-contract';
import { CheckoutSummary } from './ui/CheckoutSummary';

export function renderCheckoutPage(quote: Quote): string {
  const body = renderToStaticMarkup(<CheckoutSummary quote={quote} />);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checkout</title></head><body><main id="checkout">${body}</main></body></html>`;
}
