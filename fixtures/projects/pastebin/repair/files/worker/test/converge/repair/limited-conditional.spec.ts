import { expect, test } from "vitest"
import { createExecutionContext } from "cloudflare:test"
import { upload, workerFetch } from "../../testUtils.js"

test("a limited paste never answers 304 and uses a view on each conditional read", async () => {
  const ctx = createExecutionContext()
  const uploaded = await upload(ctx, { c: "two views only", views: "2" })

  const first = await workerFetch(ctx, uploaded.url)
  expect(first.status).toStrictEqual(200)
  expect(first.headers.get("Cache-Control")).toStrictEqual("no-store")
  expect(first.headers.has("ETag")).toStrictEqual(false)

  const conditional = await workerFetch(
    ctx,
    new Request(uploaded.url, {
      headers: { "If-None-Match": "*", "If-Modified-Since": new Date(Date.now() + 3600_000).toUTCString() },
    }),
  )
  expect(conditional.status).toStrictEqual(200)
  expect(await conditional.text()).toStrictEqual("two views only")

  expect((await workerFetch(ctx, uploaded.url)).status).toStrictEqual(404)
})

test("a paste without a limit keeps its ETag and 304 answer", async () => {
  const ctx = createExecutionContext()
  const uploaded = await upload(ctx, { c: "no limit" })
  const etag = (await workerFetch(ctx, uploaded.url)).headers.get("ETag")
  expect(etag).toMatch(/^"[^"]+"$/)
  const notModified = await workerFetch(ctx, new Request(uploaded.url, { headers: { "If-None-Match": etag! } }))
  expect(notModified.status).toStrictEqual(304)
})
