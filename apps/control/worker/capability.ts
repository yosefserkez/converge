import { DomainError, PreviewCapability, canonicalJson } from '@converge/domain';

// Signed, candidate-scoped, expiring preview capability.
// Token format: base64url(canonical payload) "." base64url(HMAC-SHA256).
// PREVIEW_SIGNING_KEY may hold "current,previous" so an old key stays valid for
// a short grace period after rotation. Only the first key signs.

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new DomainError('INTERNAL', 'preview signing key is too short');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function keys(secretSetting: string | undefined): string[] {
  const list = (secretSetting ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (list.length === 0) throw new DomainError('DEPENDENCY_UNAVAILABLE', 'preview signing key is not configured');
  return list.slice(0, 2);
}

export async function signCapability(secretSetting: string | undefined, cap: PreviewCapability): Promise<string> {
  const payload = encoder.encode(canonicalJson(PreviewCapability.parse(cap)));
  const key = await hmacKey(keys(secretSetting)[0]!);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
  return `${b64url(payload)}.${b64url(sig)}`;
}

export async function verifyCapability(secretSetting: string | undefined, token: string): Promise<PreviewCapability> {
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new DomainError('FORBIDDEN', 'malformed capability');
  const [payloadPart, sigPart] = token.split('.') as [string, string];
  const payload = fromB64url(payloadPart);
  const sig = fromB64url(sigPart);
  for (const secret of keys(secretSetting)) {
    const key = await hmacKey(secret);
    if (await crypto.subtle.verify('HMAC', key, sig as Uint8Array<ArrayBuffer>, payload as Uint8Array<ArrayBuffer>)) {
      const cap = PreviewCapability.parse(JSON.parse(new TextDecoder().decode(payload)));
      // Reject a payload that is valid JSON but not in canonical form.
      if (canonicalJson(cap) !== new TextDecoder().decode(payload)) throw new DomainError('FORBIDDEN', 'non-canonical capability');
      return cap;
    }
  }
  throw new DomainError('FORBIDDEN', 'invalid capability signature');
}
