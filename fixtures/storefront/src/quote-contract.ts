// Protected response contract (quote response version 1) and the pricing
// function signature that the pricing, cache, and server modules share.
import type { CustomerContext } from './customer-fixtures';

export interface Quote {
  productId: string;
  listPriceCents: number;
  unitPriceCents: number;
  /** Per-unit savings: listPriceCents - unitPriceCents. */
  savingsCents: number;
  quantity: number;
  totalCents: number;
  currency: 'USD';
}

export interface UnitPriceInput {
  productId: string;
  customer: CustomerContext;
}

export interface UnitPrice {
  listPriceCents: number;
  unitPriceCents: number;
}

export type UnitPriceFn = (input: UnitPriceInput) => UnitPrice;

export const QUOTE_KEYS = [
  'productId',
  'listPriceCents',
  'unitPriceCents',
  'savingsCents',
  'quantity',
  'totalCents',
  'currency',
] as const;

export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 20;

function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isValidQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_QUANTITY && value <= MAX_QUANTITY;
}

/** Returns a list of problems. An empty list means the value is a valid Quote. */
export function validateQuote(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['quote must be an object'];
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(record)) {
    if (!(QUOTE_KEYS as readonly string[]).includes(key)) problems.push(`unexpected field ${key}`);
  }
  if (typeof record.productId !== 'string' || record.productId.length === 0) problems.push('productId must be a string');
  for (const key of ['listPriceCents', 'unitPriceCents', 'savingsCents', 'totalCents'] as const) {
    if (!isCents(record[key])) problems.push(`${key} must be a non-negative integer`);
  }
  if (!isValidQuantity(record.quantity)) problems.push(`quantity must be an integer from ${MIN_QUANTITY} to ${MAX_QUANTITY}`);
  if (record.currency !== 'USD') problems.push('currency must be USD');
  if (problems.length === 0) {
    const q = record as unknown as Quote;
    if (q.totalCents !== q.unitPriceCents * q.quantity) problems.push('totalCents must equal unitPriceCents * quantity');
    if (q.savingsCents !== q.listPriceCents - q.unitPriceCents) problems.push('savingsCents must equal listPriceCents - unitPriceCents');
  }
  return problems;
}

export function isQuote(value: unknown): value is Quote {
  return validateQuote(value).length === 0;
}
