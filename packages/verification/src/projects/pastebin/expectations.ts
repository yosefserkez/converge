/** Bump whenever any pastebin check's behavior or expectation changes. */
export const PASTEBIN_HARNESS_VERSION = 'pastebin-harness/1';

/**
 * Fixed facts the pastebin checks assert. Paste contents are ASCII, so the
 * harness can send its own multipart bodies as text.
 */
export const PASTEBIN_EXPECTATIONS = {
  /** Every check paste expires soon, so a run against production leaves little behind. */
  expiration: '1h',
  expirationSeconds: 3600,
  contents: {
    roundtrip: 'converge roundtrip paste\nline two\n',
    limit: 'converge view-limit paste\n',
    unlimited: 'converge unlimited paste\n',
    cacheSafety: 'converge cache-safety paste\n',
    conditional: 'converge conditional paste\n',
    conditionalUpdated: 'converge conditional paste, updated and longer\n',
    display: 'converge display paste\n',
  },
  /** views.limit: a paste with this limit allows exactly this many content reads. */
  limitViews: 2,
  cacheSafetyViews: 2,
  displayViews: 3,
  /** Values of the views field that the upload must reject with 400. */
  invalidViews: ['0', '1001', '1.5', 'abc', '', '-1'],
  /** Public caching of unlimited raw reads: at least this max-age (CACHE_PASTE_AGE in wrangler.toml). */
  minPublicMaxAge: 600,
  statuses: { ok: 200, notModified: 304, badRequest: 400, notFound: 404 },
  /** Placeholder for a paste name that does not exist. */
  missingName: 'zzzzzzzzzzzz',
  /** Visible-text patterns on the display page. `{v}` is the escaped value. */
  displayPatterns: {
    remaining: '(remaining\\s+views|views\\s+(remaining|left))\\s*:?\\s*{v}(?![\\w])|(?<![\\w]){v}\\s+views?\\s+(remaining|left)',
    brokenValue: '\\b(NaN|undefined|null)\\b|\\[object Object\\]',
  },
  docs: { path: '/doc/api.md', fieldPatterns: ['`views`', '`viewsRemaining`'] },
} as const;
