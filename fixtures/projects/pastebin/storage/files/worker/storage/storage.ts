import { dateToUnix, workerAssert, WorkerError } from "../common.js"
import { parseSize } from "../../shared/parsers.js"
import type { MetaResponse, PasteLocation } from "../../shared/interfaces.js"

// since CF does not allow expiration shorter than 60s, extend the expiration to 70s
const PASTE_EXPIRE_SPECIFIED_MIN = 70

// The largest view limit that an upload can set.
export const MAX_VIEWS_LIMIT = 1000

// TODO: allow admin to upload permanent paste
// TODO: add filename length check
export interface PasteMetadata {
  schemaVersion: 1
  location: PasteLocation // new field on V1
  passwd: string

  lastModifiedAtUnix: number
  createdAtUnix: number
  willExpireAtUnix: number

  accessCounter: number // a counter representing how frequent it is accessed, to administration usage
  sizeBytes: number
  filename?: string
  highlightLanguage?: string
  encryptionScheme?: string

  // View limit. Both fields are absent for a paste without a limit.
  // maxViews: the limit that the upload set (1 to MAX_VIEWS_LIMIT).
  // viewsRemaining: the number of content reads that are left. Each content
  // read decrements it. The read that sets it to 0 deletes the paste.
  maxViews?: number
  viewsRemaining?: number
}

interface PasteMetadataInStorage {
  schemaVersion: number
  location?: PasteLocation
  passwd: string

  lastModifiedAtUnix: number
  createdAtUnix: number
  willExpireAtUnix: number

  accessCounter?: number
  sizeBytes?: number
  filename?: string
  highlightLanguage?: string
  encryptionScheme?: string

  maxViews?: number
  viewsRemaining?: number
}

export function metaResponseFromMetadata(metadata: PasteMetadata): MetaResponse {
  return {
    lastModifiedAt: new Date(metadata.lastModifiedAtUnix * 1000).toISOString(),
    createdAt: new Date(metadata.createdAtUnix * 1000).toISOString(),
    expireAt: new Date(metadata.willExpireAtUnix * 1000).toISOString(),
    sizeBytes: metadata.sizeBytes,
    location: metadata.location,
    filename: metadata.filename,
    highlightLanguage: metadata.highlightLanguage,
    encryptionScheme: metadata.encryptionScheme,
    maxViews: metadata.maxViews,
    viewsRemaining: metadata.viewsRemaining,
  }
}

// Returns true when the paste has a view limit.
export function isViewLimited(metadata: PasteMetadata): boolean {
  return metadata.viewsRemaining !== undefined
}

// Parses the `views` upload field: an integer from 1 to MAX_VIEWS_LIMIT.
export function parseMaxViews(value: string): number {
  const trimmed = value.trim()
  const views = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
  if (!Number.isSafeInteger(views) || views < 1 || views > MAX_VIEWS_LIMIT) {
    throw new WorkerError(400, `'${value}' is not a valid view limit (use an integer from 1 to ${MAX_VIEWS_LIMIT})`)
  }
  return views
}

// Old metadata has no view fields. A paste without them has no view limit.
function migrateViewLimit(original: PasteMetadataInStorage): Pick<PasteMetadata, "maxViews" | "viewsRemaining"> {
  const { maxViews, viewsRemaining } = original
  if (maxViews === undefined || viewsRemaining === undefined) {
    return {}
  }
  return { maxViews, viewsRemaining }
}

function migratePasteMetadata(original: PasteMetadataInStorage): PasteMetadata {
  return {
    schemaVersion: 1,
    location: original.location || "KV",
    passwd: original.passwd,

    lastModifiedAtUnix: original.lastModifiedAtUnix,
    createdAtUnix: original.createdAtUnix,
    willExpireAtUnix: original.willExpireAtUnix,

    accessCounter: original.accessCounter || 0,
    sizeBytes: original.sizeBytes || 0,
    filename: original.filename,
    highlightLanguage: original.highlightLanguage,
    encryptionScheme: original.encryptionScheme,
    ...migrateViewLimit(original),
  }
}

export interface PasteWithMetadata {
  paste: ArrayBuffer | ReadableStream
  metadata: PasteMetadata
  httpEtag?: string
}

async function updateAccessCounter(env: Env, short: string, value: ArrayBuffer, metadata: PasteMetadata) {
  // update counter with probability 1%
  if (Math.random() < 0.01) {
    metadata.accessCounter += 1
    try {
      await env.PB.put(short, value, {
        metadata: metadata,
        expiration: metadata.willExpireAtUnix,
      })
    } catch (e) {
      // ignore rate limit message
      if (!(e as Error).message.includes("KV PUT failed: 429 Too Many Requests")) {
        throw e
      }
    }
  }
}

// KV refuses an expiration less than 60 seconds in the future.
function kvExpiration(metadata: PasteMetadata): number {
  return Math.max(metadata.willExpireAtUnix, dateToUnix(new Date()) + PASTE_EXPIRE_SPECIFIED_MIN)
}

// Consumes one view of a limited paste and returns its content.
// The returned metadata shows the views that are left after this read.
// The read that uses the last view deletes the paste.
// KV has no atomic update, so two reads at the same time can both use the same view.
async function consumeView(
  env: Env,
  short: string,
  kvValue: ArrayBuffer,
  metadata: PasteMetadata,
): Promise<PasteWithMetadata | null> {
  const before = metadata.viewsRemaining ?? 0
  if (before <= 0) {
    await deletePaste(env, short, metadata)
    return null
  }
  const consumed: PasteMetadata = {
    ...metadata,
    viewsRemaining: before - 1,
    accessCounter: metadata.accessCounter + 1,
  }
  const isLastView = consumed.viewsRemaining === 0

  let paste: ArrayBuffer | ReadableStream = kvValue
  let httpEtag: string | undefined
  if (metadata.location === "R2") {
    const object = await env.R2.get(short)
    if (object === null) {
      return null
    }
    // Read the whole object before the delete removes it.
    paste = isLastView ? await object.arrayBuffer() : object.body
    httpEtag = object.httpEtag
  }

  if (isLastView) {
    await deletePaste(env, short, metadata)
  } else {
    await env.PB.put(short, kvValue, { metadata: consumed, expiration: kvExpiration(consumed) })
  }
  return { paste, metadata: consumed, httpEtag }
}

export async function getPaste(env: Env, short: string, ctx: ExecutionContext): Promise<PasteWithMetadata | null> {
  const item = await env.PB.getWithMetadata<PasteMetadataInStorage>(short, {
    type: "arrayBuffer",
  })

  if (item.value === null) {
    return null
  } else {
    workerAssert(item.metadata != null, `paste of name '${short}' has no metadata`)
    const metadata = migratePasteMetadata(item.metadata)
    const expired = metadata.willExpireAtUnix < new Date().getTime() / 1000

    if (!expired && isViewLimited(metadata)) {
      // A limited paste writes its metadata on each read. Do not also run the
      // access counter update, because it writes the old metadata.
      return await consumeView(env, short, item.value, metadata)
    }

    ctx.waitUntil(
      (async () => {
        if (expired) {
          await deletePaste(env, short, metadata)
          return null
        }
        await updateAccessCounter(env, short, item.value!, metadata)
      })(),
    )

    if (expired) {
      return null
    }

    if (metadata.location === "R2") {
      const object = await env.R2.get(short)
      if (object === null) {
        return null
      }
      return { paste: object.body, metadata, httpEtag: object.httpEtag }
    } else {
      return { paste: item.value, metadata }
    }
  }
}

// we separate usage of getPasteMetadata and getPaste to make access metric more reliable
export async function getPasteMetadata(env: Env, short: string): Promise<PasteMetadata | null> {
  const item = await env.PB.getWithMetadata<PasteMetadataInStorage>(short, {
    type: "stream",
  })

  if (item.value === null) {
    return null
  } else if (item.metadata === null) {
    throw new WorkerError(500, `paste of name '${short}' has no metadata`)
  } else {
    if (item.metadata.willExpireAtUnix < new Date().getTime() / 1000) {
      return null
    }
    return migratePasteMetadata(item.metadata)
  }
}

interface WriteOptions {
  now: Date
  contentLength: number
  expirationSeconds: number
  passwd: string
  filename?: string
  highlightLanguage?: string
  encryptionScheme?: string
  isMPUComplete: boolean
  // View limit from the `views` upload field. Undefined means no new limit.
  maxViews?: number
}

// A new view limit starts with all views left. An update without a new
// limit keeps the views that are left.
function viewLimitFor(options: WriteOptions, original?: PasteMetadata): Pick<PasteMetadata, "maxViews" | "viewsRemaining"> {
  if (options.maxViews !== undefined) {
    return { maxViews: options.maxViews, viewsRemaining: options.maxViews }
  }
  if (original !== undefined && isViewLimited(original)) {
    return { maxViews: original.maxViews, viewsRemaining: original.viewsRemaining }
  }
  return {}
}

export async function updatePaste(
  env: Env,
  pasteName: string,
  content: ArrayBuffer | ReadableStream,
  originalMetadata: PasteMetadata,
  options: WriteOptions,
): Promise<PasteMetadata> {
  const expirationUnix = dateToUnix(options.now) + options.expirationSeconds
  const expirationUnixSpecified =
    dateToUnix(options.now) + Math.max(options.expirationSeconds, PASTE_EXPIRE_SPECIFIED_MIN)

  // if the paste is previous on R2, we keep it on R2 to avoid losing reference to it
  const newLocation =
    originalMetadata.location === "R2" || options.isMPUComplete || options.contentLength > parseSize(env.R2_THRESHOLD)!
      ? "R2"
      : "KV"

  if (newLocation === "R2" && !options.isMPUComplete) {
    await env.R2.put(pasteName, content, {
      customMetadata: { willExpireAtUnix: String(expirationUnix) },
    })
  }

  const metadata: PasteMetadata = {
    schemaVersion: 1,
    location: newLocation,
    filename: options.filename,
    highlightLanguage: options.highlightLanguage,
    passwd: options.passwd,

    lastModifiedAtUnix: dateToUnix(options.now),
    createdAtUnix: originalMetadata.createdAtUnix,
    willExpireAtUnix: expirationUnix,
    accessCounter: originalMetadata.accessCounter,
    sizeBytes: options.contentLength,
    encryptionScheme: options.encryptionScheme,
    ...viewLimitFor(options, originalMetadata),
  }

  await env.PB.put(pasteName, newLocation === "R2" ? "" : content, {
    metadata: metadata,
    expiration: expirationUnixSpecified,
  })

  return metadata
}

export async function createPaste(
  env: Env,
  pasteName: string,
  content: ArrayBuffer | ReadableStream,
  options: WriteOptions,
): Promise<PasteMetadata> {
  const expirationUnix = dateToUnix(options.now) + options.expirationSeconds

  const expirationUnixSpecified =
    dateToUnix(options.now) + Math.max(options.expirationSeconds, PASTE_EXPIRE_SPECIFIED_MIN)

  const location = options.isMPUComplete || options.contentLength > parseSize(env.R2_THRESHOLD)! ? "R2" : "KV"
  if (location === "R2" && !options.isMPUComplete) {
    await env.R2.put(pasteName, content, {
      customMetadata: { willExpireAtUnix: String(expirationUnix) },
    })
  }

  const metadata: PasteMetadata = {
    schemaVersion: 1,
    location: location,
    filename: options.filename,
    highlightLanguage: options.highlightLanguage,
    passwd: options.passwd,

    lastModifiedAtUnix: dateToUnix(options.now),
    createdAtUnix: dateToUnix(options.now),
    willExpireAtUnix: expirationUnix,
    accessCounter: 0,
    sizeBytes: options.contentLength,
    encryptionScheme: options.encryptionScheme,
    ...viewLimitFor(options),
  }

  await env.PB.put(pasteName, location === "R2" ? "" : content, {
    metadata: metadata,
    expiration: expirationUnixSpecified,
  })

  return metadata
}

export async function pasteNameAvailable(env: Env, pasteName: string): Promise<boolean> {
  const item = await env.PB.getWithMetadata<PasteMetadata>(pasteName)
  if (item.value == null) {
    return true
  } else if (item.metadata === null) {
    throw new WorkerError(500, `paste of name '${pasteName}' has no metadata`)
  } else {
    return item.metadata.willExpireAtUnix < new Date().getTime() / 1000
  }
}

export async function deletePaste(env: Env, pasteName: string, originalMetadata: PasteMetadata): Promise<void> {
  if (originalMetadata.location === "R2") {
    await env.R2.delete(pasteName)
  }
  await env.PB.delete(pasteName)
}

export async function cleanExpiredInR2(env: Env, controller: ScheduledController) {
  const nowUnix = controller.scheduledTime / 1000

  // phase 1: collect all expired keys
  const toDelete: string[] = []

  let cursor: string | undefined
  while (true) {
    const listed = await env.R2.list({ cursor, limit: 1000, include: ["customMetadata"] })

    // separate objects with and without custom metadata
    const needKvLookup: R2Object[] = []
    for (const obj of listed.objects) {
      const expStr = obj.customMetadata?.willExpireAtUnix
      if (expStr) {
        if (Number(expStr) < nowUnix) {
          toDelete.push(obj.key)
        }
      } else {
        needKvLookup.push(obj)
      }
    }

    // batch KV lookups for legacy/MPU objects without custom metadata
    const kvResults = await Promise.all(needKvLookup.map((obj) => getPasteMetadata(env, obj.key)))
    for (let i = 0; i < needKvLookup.length; i++) {
      const kvMeta = kvResults[i]
      if (kvMeta === null || kvMeta.willExpireAtUnix < nowUnix) {
        toDelete.push(needKvLookup[i].key)
      }
    }

    if (listed.truncated) {
      cursor = listed.cursor
    } else {
      break
    }
  }

  // phase 2: batch delete in chunks of 1000
  let numCleaned = 0
  for (let i = 0; i < toDelete.length; i += 1000) {
    const batch = toDelete.slice(i, i + 1000)
    await env.R2.delete(batch)
    numCleaned += batch.length
  }

  console.log(`${numCleaned} R2 objects cleaned`)
}
