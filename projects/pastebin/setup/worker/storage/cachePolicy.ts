import type { PasteMetadata } from "./storage.js"

// Converge setup: the Cache-Control policy for paste responses (raw content,
// metadata, display page, and article page). It was a private helper in
// handlers/handleRead.ts. The setup commit moved it here without a change in
// behavior, so that the storage layer can decide how long a paste may be cached.
export function pasteCacheHeaders(env: Env, _metadata: PasteMetadata): Record<string, string> {
  const age = env.CACHE_PASTE_AGE
  return age ? { "Cache-Control": `public, max-age=${age}` } : {}
}
