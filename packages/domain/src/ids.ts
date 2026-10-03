import { DomainError } from './errors.ts';
import { Id, RepoName } from './schemas.ts';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const PREFIX = /^[a-z][a-z0-9]{0,15}$/;

function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** `<prefix>_<26 lowercase base32 chars>` carrying 128 random bits. */
export function newId(prefix: string): Id {
  if (!PREFIX.test(prefix)) throw new DomainError('INVALID_INPUT', `invalid id prefix ${prefix}`);
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Id.parse(`${prefix}_${base32(bytes)}`);
}

export type RepoKind = 'baseline' | 'proposal' | 'candidate';
const KIND_CODE: Record<RepoKind, string> = { baseline: 'b', proposal: 'p', candidate: 'c' };
const MAX_REPO_NAME = 63;

/** 32-bit FNV-1a, hex. Sync and deterministic; used only to shorten names, not for integrity. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Deterministic flat Artifacts repo name: `cv-<session>-<kind>-<suffix>`.
 * Names over 63 chars are truncated and tagged with a hash of the full name.
 */
export function repoNameFor(kind: RepoKind, sessionId: string, suffix: string): string {
  const parts = [slug(sessionId), KIND_CODE[kind], slug(suffix)];
  if (!parts[0] || !parts[2]) throw new DomainError('INVALID_INPUT', 'session id and suffix must contain [a-z0-9]');
  let name = `cv-${parts.join('-')}`;
  if (name.length > MAX_REPO_NAME) {
    const tag = fnv1a(name);
    name = `${name.slice(0, MAX_REPO_NAME - tag.length - 1).replace(/-+$/, '')}-${tag}`;
  }
  return RepoName.parse(name);
}
