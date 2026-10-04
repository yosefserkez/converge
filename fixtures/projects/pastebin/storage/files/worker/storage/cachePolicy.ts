import type { PasteMetadata } from "./storage.js"
import { isViewLimited } from "./storage.js"

// The Cache-Control policy for paste responses (raw content, metadata,
// display page, and article page).
//
// A paste with a view limit must not be cached. Each content read uses a view,
// and a cache that serves a copy lets a reader see the paste without a view.
// Its metadata changes on each read, so it must not be cached too.
export function pasteCacheHeaders(env: Env, metadata: PasteMetadata): Record<string, string> {
  if (isViewLimited(metadata)) {
    return { "Cache-Control": "no-store" }
  }
  const age = env.CACHE_PASTE_AGE
  return age ? { "Cache-Control": `public, max-age=${age}` } : {}
}
