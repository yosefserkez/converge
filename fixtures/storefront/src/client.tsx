// Protected browser entry. All URLs are relative because previews are served
// under a /p/<capability>/ path prefix.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isQuote, MAX_QUANTITY, MIN_QUANTITY, type Quote } from './quote-contract';
import { CheckoutSummary } from './ui/CheckoutSummary';
import './ui/checkout.css';

const PRODUCTS = [
  { id: 'backpack', label: 'Trail backpack' },
  { id: 'notebook', label: 'Field notebook' },
];
const CUSTOMERS = [
  { id: 'member-1', label: 'member-1 (member)' },
  { id: 'regular-1', label: 'regular-1 (regular)' },
];

interface QuoteState {
  quote: Quote | null;
  loading: boolean;
  error: string | null;
}

function App() {
  const [productId, setProductId] = useState('backpack');
  const [quantity, setQuantity] = useState(1);
  const [customerId, setCustomerId] = useState('member-1');
  const [state, setState] = useState<QuoteState>({ quote: null, loading: true, error: null });

  useEffect(() => {
    const controller = new AbortController();
    setState({ quote: null, loading: true, error: null });
    fetch('./api/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-demo-customer': customerId },
      body: JSON.stringify({ productId, quantity }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`Quote request failed (${res.status})`);
        if (!isQuote(body)) throw new Error('Quote response did not match the contract');
        setState({ quote: body, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ quote: null, loading: false, error: err instanceof Error ? err.message : 'Quote request failed' });
      });
    return () => controller.abort();
  }, [productId, quantity, customerId]);

  return (
    <div className="checkout-page">
      <h1>Checkout</h1>
      <form className="checkout-controls" onSubmit={(e) => e.preventDefault()}>
        <label>
          Customer
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            {CUSTOMERS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <label>
          Product
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            {PRODUCTS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
        <label>
          Quantity
          <input
            type="number"
            min={MIN_QUANTITY}
            max={MAX_QUANTITY}
            step={1}
            value={quantity}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (Number.isInteger(next)) setQuantity(Math.min(MAX_QUANTITY, Math.max(MIN_QUANTITY, next)));
            }}
          />
        </label>
      </form>
      <CheckoutSummary quote={state.quote} loading={state.loading} error={state.error} />
      <p className="demo-note">Synthetic demo store. The customer selector is not a real sign-in.</p>
    </div>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
