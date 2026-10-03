// Single canonical JSON serializer used for every digest in the system.
// Object keys are sorted by UTF-16 code unit order; arrays keep their order
// unless the caller explicitly normalizes a set with `canonicalSet`.

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export class CanonicalJsonError extends Error {}

export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number at ${path}`);
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => {
          if (item === undefined) throw new CanonicalJsonError(`undefined array item at ${path}[${i}]`);
          return serialize(item, `${path}[${i}]`);
        }).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError(`unsupported object type at ${path}`);
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value} at ${path}`);
  }
}

/** Sort and dedupe an array that semantically represents a set of strings. */
export function canonicalSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

const encoder = new TextEncoder();

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Digest strings are `sha256:<64 lowercase hex>`; Git object IDs are separate. */
export async function digestOf(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}

export async function digestBytes(data: string | Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(data)}`;
}
