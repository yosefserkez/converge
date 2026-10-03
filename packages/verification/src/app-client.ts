import type { AppInstance, AppResponse } from './types.ts';

export type JsonParse = { ok: true; value: unknown } | { ok: false; error: string };

export function parseJson(text: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON' };
  }
}

export interface QuoteCall {
  response: AppResponse;
  /** Parsed JSON body, or null when the body is not JSON. */
  json: unknown;
}

/** Reads a numeric field from a parsed body; null when absent or not a number. */
export function numberField(json: unknown, key: string): number | null {
  if (typeof json !== 'object' || json === null) return null;
  const value = (json as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

export function header(response: AppResponse, name: string): string {
  return response.headers[name.toLowerCase()] ?? '';
}

export async function postQuoteRaw(app: AppInstance, customerId: string | null, body: string): Promise<QuoteCall> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (customerId !== null) headers['x-demo-customer'] = customerId;
  const response = await app.request({ method: 'POST', path: '/api/quote', headers, body });
  const parsed = parseJson(response.bodyText);
  return { response, json: parsed.ok ? parsed.value : null };
}

export function postQuote(app: AppInstance, customerId: string | null, body: unknown): Promise<QuoteCall> {
  return postQuoteRaw(app, customerId, JSON.stringify(body));
}

export async function getComputeCount(app: AppInstance): Promise<number | null> {
  const response = await app.request({ method: 'GET', path: '/__diagnostics/compute-count' });
  if (response.status !== 200) return null;
  const parsed = parseJson(response.bodyText);
  const count = parsed.ok ? numberField(parsed.value, 'count') : null;
  return count !== null && Number.isSafeInteger(count) && count >= 0 ? count : null;
}
