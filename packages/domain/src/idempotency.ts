import { digestOf } from './canonical.ts';

/** Receipt scope: authenticated actor + project + command type. Parts are escaped so ':' cannot collide. */
export function commandScope(actor: string, projectId: string, commandType: string): string {
  return [actor, projectId, commandType].map(encodeURIComponent).join(':');
}

export function requestDigest(body: unknown): Promise<string> {
  return digestOf(body);
}

export type ReceiptDecision = 'new' | 'replay' | 'mismatch';

/** Same key + same body replays the stored response; same key + other body is a 409. */
export function decideReceipt(existing: { requestDigest: string } | null, digest: string): ReceiptDecision {
  if (!existing) return 'new';
  return existing.requestDigest === digest ? 'replay' : 'mismatch';
}
