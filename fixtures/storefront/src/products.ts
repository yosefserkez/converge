// Protected synthetic catalog. Prices are integer cents and stay fixed for the
// lifetime of one process.
export interface Product {
  id: string;
  name: string;
  listPriceCents: number;
  currency: 'USD';
}

export const PRODUCTS: Readonly<Record<string, Product>> = Object.freeze({
  backpack: { id: 'backpack', name: 'Trail backpack', listPriceCents: 10000, currency: 'USD' },
  notebook: { id: 'notebook', name: 'Field notebook', listPriceCents: 2500, currency: 'USD' },
});

export const PRODUCT_IDS = Object.keys(PRODUCTS);

export function getProduct(productId: string): Product | undefined {
  return Object.hasOwn(PRODUCTS, productId) ? PRODUCTS[productId] : undefined;
}
