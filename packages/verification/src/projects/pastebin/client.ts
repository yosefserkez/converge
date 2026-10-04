// HTTP helpers for the pastebin checks. Workers-safe: no node: imports.
import { header, parseJson } from '../../app-client.ts';
import type { AppInstance, AppResponse } from '../../types.ts';
import { PASTEBIN_EXPECTATIONS } from './expectations.ts';

/** Fixed boundary, so that the same fields always give the same request bytes. */
export const MULTIPART_BOUNDARY = 'converge-harness-boundary-5f2c9e';

const SAFE_TEXT = /^[\t\n\r\x20-\x7e]*$/;
const FIELD_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Builds a multipart/form-data body as text. The harness builds the body
 * itself, so candidate code never shapes the request. Values must be ASCII and
 * must not contain the boundary.
 */
export function multipartBody(fields: Readonly<Record<string, string>>): { contentType: string; body: string } {
  let body = '';
  for (const [name, value] of Object.entries(fields)) {
    if (!FIELD_NAME.test(name)) throw new Error(`invalid multipart field name ${name}`);
    if (!SAFE_TEXT.test(value) || value.includes(MULTIPART_BOUNDARY)) throw new Error(`unsafe multipart value for field ${name}`);
    body += `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  body += `--${MULTIPART_BOUNDARY}--\r\n`;
  return { contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`, body };
}

/** Path of an absolute URL that the app returned; null when the value is not a URL. */
export function pathOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.pathname.length > 1 ? url.pathname : null;
  } catch {
    return null;
  }
}

export function field(json: unknown, key: string): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  return (json as Record<string, unknown>)[key];
}

export interface UploadCall {
  response: AppResponse;
  json: unknown;
  /** Path of the paste, e.g. "/AbCd"; null when the response has no usable url. */
  path: string | null;
  /** Path of the manage URL, e.g. "/AbCd:secret"; null when absent. */
  managePath: string | null;
}

/** POST / (or PUT <managePath>) with multipart fields. Adds the short expiration unless the caller sets one. */
export async function upload(
  app: AppInstance,
  fields: Readonly<Record<string, string>>,
  options: { method?: 'POST' | 'PUT'; path?: string } = {},
): Promise<UploadCall> {
  const { contentType, body } = multipartBody({ e: PASTEBIN_EXPECTATIONS.expiration, ...fields });
  const response = await app.request({
    method: options.method ?? 'POST',
    path: options.path ?? '/',
    headers: { 'content-type': contentType },
    body,
  });
  const parsed = parseJson(response.bodyText);
  const json = parsed.ok ? parsed.value : null;
  return { response, json, path: pathOf(field(json, 'url')), managePath: pathOf(field(json, 'manageUrl')) };
}

export function get(app: AppInstance, path: string, headers: Record<string, string> = {}): Promise<AppResponse> {
  return app.request({ method: 'GET', path, headers });
}

export function head(app: AppInstance, path: string): Promise<AppResponse> {
  return app.request({ method: 'HEAD', path });
}

/** "/AbCd" -> "/m/AbCd" (metadata) or "/d/AbCd" (display page). */
export function rolePath(role: 'm' | 'd', path: string): string {
  return `/${role}${path}`;
}

export interface MetaCall {
  response: AppResponse;
  json: unknown;
}

export async function readMeta(app: AppInstance, path: string): Promise<MetaCall> {
  const response = await get(app, rolePath('m', path));
  const parsed = parseJson(response.bodyText);
  return { response, json: parsed.ok ? parsed.value : null };
}

/** Deletes a check paste. Best effort: cleanup never decides a check. */
export async function cleanup(app: AppInstance, managePath: string | null): Promise<void> {
  if (managePath === null) return;
  await app.request({ method: 'DELETE', path: managePath }).catch(() => undefined);
}

export function cacheControl(response: AppResponse): string {
  return header(response, 'cache-control');
}

/** max-age in seconds, or null when absent. */
export function maxAge(cacheControlValue: string): number | null {
  const match = /(?:^|[,\s])max-age=(\d+)/i.exec(cacheControlValue);
  return match ? Number(match[1]) : null;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
