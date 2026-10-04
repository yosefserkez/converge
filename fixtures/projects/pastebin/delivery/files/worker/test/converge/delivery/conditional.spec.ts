import { expect, test } from "vitest"
import { createExecutionContext, env } from "cloudflare:test"
import { upload, workerFetch } from "../../testUtils.js"

test("raw reads send a strong ETag and answer a matching If-None-Match with 304", async () => {
  const ctx = createExecutionContext()
  const uploaded = await upload(ctx, { c: "conditional content" })

  const first = await workerFetch(ctx, uploaded.url)
  expect(first.status).toStrictEqual(200)
  const etag = first.headers.get("ETag")
  expect(etag).toMatch(/^"[^"]+"$/)
  expect(first.headers.get("Cache-Control")).toStrictEqual(`public, max-age=${env.CACHE_PASTE_AGE}`)

  const second = await workerFetch(ctx, uploaded.url)
  expect(second.headers.get("ETag")).toStrictEqual(etag)

  const notModified = await workerFetch(ctx, new Request(uploaded.url, { headers: { "If-None-Match": etag! } }))
  expect(notModified.status).toStrictEqual(304)
  expect(notModified.headers.get("ETag")).toStrictEqual(etag)
  expect(await notModified.text()).toStrictEqual("")

  const other = await workerFetch(ctx, new Request(uploaded.url, { headers: { "If-None-Match": '"other"' } }))
  expect(other.status).toStrictEqual(200)
  expect(await other.text()).toStrictEqual("conditional content")
})

test("an update changes the ETag", async () => {
  const ctx = createExecutionContext()
  const uploaded = await upload(ctx, { c: "first version" })
  const etag = (await workerFetch(ctx, uploaded.url)).headers.get("ETag")!

  await upload(ctx, { c: "second, longer version" }, { method: "PUT", url: uploaded.manageUrl })
  const updated = await workerFetch(ctx, new Request(uploaded.url, { headers: { "If-None-Match": etag } }))
  expect(updated.status).toStrictEqual(200)
  expect(await updated.text()).toStrictEqual("second, longer version")
  expect(updated.headers.get("ETag")).not.toStrictEqual(etag)
})

test("a missing paste is 404 with or without If-None-Match", async () => {
  const ctx = createExecutionContext()
  const missing = await workerFetch(ctx, new Request(`${env.DEPLOY_URL}/zzzzzzzz`, { headers: { "If-None-Match": "*" } }))
  expect(missing.status).toStrictEqual(404)
})
