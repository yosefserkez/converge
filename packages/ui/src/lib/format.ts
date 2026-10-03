// Pure formatting helpers. They have unit tests in packages/ui/test.

/** Integer micro-USD to a dollar string. Values under one cent keep four decimals. */
export function formatMicroUsd(micro: number | null | undefined): string {
  if (micro === null || micro === undefined || !Number.isFinite(micro)) return '$0.00';
  const negative = micro < 0;
  const abs = Math.abs(Math.trunc(micro));
  const dollars = abs / 1_000_000;
  const digits = abs !== 0 && abs < 10_000 ? 4 : 2;
  const text = dollars.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${negative ? '-' : ''}$${text}`;
}

/** Dollar input text to integer micro-USD. Returns null for invalid or negative input. */
export function parseDollarsToMicroUsd(text: string): number | null {
  const t = text.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 1_000_000 + Number(frac.padEnd(6, '0'));
}

/** Integer cents to a dollar string, as the storefront shows prices. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** First seven characters of a Git object ID. */
export function shortSha(sha: string | null | undefined, length = 7): string {
  if (!sha) return '—';
  const hex = sha.replace(/^sha256:/, '');
  return hex.slice(0, length);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Short relative time such as "12 s ago". */
export function formatAgo(epochMs: number, now = Date.now()): string {
  const d = Math.max(0, now - epochMs);
  if (d < 5000) return 'now';
  return `${formatDuration(d)} ago`;
}

/** Seconds left as m:ss. */
export function formatCountdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Safe single-line text for an unknown value. Never HTML. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Human words for a snake_case or dotted status. */
export function humanize(s: string): string {
  const t = s.replace(/[_.-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
