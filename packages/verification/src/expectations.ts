import type { Capability } from '@converge/domain';

/** Bump whenever any check's behavior or expectation changes. */
export const HARNESS_VERSION = 'storefront-harness/1';

export type ProductId = 'backpack' | 'notebook';
export type CustomerId = 'member-1' | 'regular-1';

/** Fixed facts the protected checks assert. All amounts are integer cents. */
export const EXPECTATIONS = {
  currency: 'USD',
  products: {
    backpack: { listPriceCents: 10000, memberPriceCents: 8000 },
    notebook: { listPriceCents: 2500, memberPriceCents: 2000 },
  },
  customers: {
    'member-1': { membershipTier: 'member' },
    'regular-1': { membershipTier: 'regular' },
  },
  memberDiscountPercent: 20,
  quantity: { min: 1, max: 20 },
  maxBodyBytes: 4096,
  statuses: { malformedJson: 400, unknownCustomer: 401, bodyTooLarge: 413, invalidInput: 422 },
  quoteKeys: ['currency', 'listPriceCents', 'productId', 'quantity', 'savingsCents', 'totalCents', 'unitPriceCents'],
  checkout: { productId: 'backpack', quantity: 3 },
  cacheReuseSteps: [
    { productId: 'backpack', quantity: 1, computeDelta: 1 },
    { productId: 'backpack', quantity: 1, computeDelta: 0 },
    { productId: 'backpack', quantity: 1, computeDelta: 0 },
    { productId: 'backpack', quantity: 3, computeDelta: 0 },
    { productId: 'notebook', quantity: 1, computeDelta: 1 },
    { productId: 'notebook', quantity: 1, computeDelta: 0 },
    { productId: 'notebook', quantity: 2, computeDelta: 0 },
  ],
} as const;

export const PRODUCT_IDS: readonly ProductId[] = ['backpack', 'notebook'];
export const CUSTOMER_IDS: readonly CustomerId[] = ['member-1', 'regular-1'];

export function listPrice(productId: ProductId): number {
  return EXPECTATIONS.products[productId].listPriceCents;
}

/** The unit price a customer must receive, given the candidate's capabilities. */
export function expectedUnitPrice(productId: ProductId, customerId: CustomerId, capabilities: ReadonlySet<Capability>): number {
  const product = EXPECTATIONS.products[productId];
  const isMember = EXPECTATIONS.customers[customerId].membershipTier === 'member';
  return isMember && capabilities.has('membership-pricing') ? product.memberPriceCents : product.listPriceCents;
}

/** US-dollar formatting of integer cents, e.g. 250005 -> "$2,500.05". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}
