import { DomainError, type EvidenceRef, canonicalJson, digestBytes } from '@converge/domain';

const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

/**
 * Write an immutable, content-addressed evidence object. The key contains the
 * digest of the exact bytes, so a retry rewrites identical bytes and the caller
 * commits the reference only after this resolves.
 */
export async function writeEvidence(
  bucket: R2Bucket,
  args: { prefix: string; body: unknown; visibility: 'private' | 'public'; contentType?: string },
): Promise<EvidenceRef> {
  const isText = typeof args.body === 'string';
  const text = isText ? (args.body as string) : canonicalJson(args.body);
  const bytes = encoder.encode(text);
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) {
    throw new DomainError('LIMIT_EXCEEDED', 'evidence object exceeds the size limit', { bytes: bytes.byteLength });
  }
  const sha256 = await digestBytes(bytes);
  const ext = isText ? 'txt' : 'json';
  const contentType = args.contentType ?? (isText ? 'text/plain; charset=utf-8' : 'application/json');
  const key = `${args.prefix}/${sha256.slice('sha256:'.length)}.${ext}`;
  if (!key.startsWith(`${args.visibility}/`)) throw new DomainError('INVALID_INPUT', 'evidence key prefix must match visibility');
  const existing = await bucket.head(key);
  if (!existing) {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: 'private, no-store' },
      customMetadata: { sha256 },
      sha256: sha256.slice('sha256:'.length),
    });
  } else if (existing.customMetadata?.sha256 !== sha256) {
    throw new DomainError('EVIDENCE_DIGEST_MISMATCH', 'existing evidence object has a different digest', { key });
  }
  return { key, sha256, bytes: bytes.byteLength, contentType, visibility: args.visibility };
}

/** Read an evidence object, verify its digest, and return parsed JSON (or text). */
export async function verifyEvidence<T = unknown>(bucket: R2Bucket, key: string, sha256: string): Promise<T> {
  const text = await readVerifiedText(bucket, key, sha256);
  return (key.endsWith('.json') ? JSON.parse(text) : text) as T;
}

export async function readVerifiedText(bucket: R2Bucket, key: string, sha256: string): Promise<string> {
  const obj = await bucket.get(key);
  if (!obj) throw new DomainError('EVIDENCE_MISSING', 'evidence object is missing', { key });
  if (obj.size > MAX_EVIDENCE_BYTES) throw new DomainError('LIMIT_EXCEEDED', 'evidence object too large to read', { key });
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const actual = await digestBytes(bytes);
  if (actual !== sha256) throw new DomainError('EVIDENCE_DIGEST_MISMATCH', 'evidence bytes do not match the recorded digest', { key });
  return new TextDecoder().decode(bytes);
}

export const evidencePrefix = (project: string, session: string, kind: 'source' | 'agent' | 'checks' | 'logs' | 'diffs' | 'receipts') =>
  `private/${project}/${session}/${kind}`;
