// Credential redaction for every string that leaves the broker: error
// messages, log lines and HTTP responses. Known secrets are replaced
// verbatim; generic Authorization/Bearer patterns are a second line of
// defence in case a secret was never registered.

export const REDACTED = '[REDACTED]';

const GENERIC_PATTERNS: readonly RegExp[] = [
  /(authorization\s*:\s*)[^\r\n]*/gi,
  /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /(extraheader\s*=?\s*)[^\r\n]*/gi,
  // userinfo embedded in a URL (scheme://user:pass@host)
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
];

export class Redactor {
  readonly #secrets = new Set<string>();

  constructor(secrets: Iterable<string> = []) {
    for (const s of secrets) this.add(s);
  }

  add(secret: string | undefined): void {
    // Very short strings would redact ordinary text; tokens are never this short.
    if (secret && secret.length >= 6) this.#secrets.add(secret);
  }

  redact(text: string): string {
    let out = text;
    // Longest first so a secret that contains another is removed whole.
    for (const s of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(s).join(REDACTED);
    }
    for (const re of GENERIC_PATTERNS) {
      out = out.replace(re, (_m, prefix: string) => `${prefix}${REDACTED}`);
    }
    return out;
  }
}
