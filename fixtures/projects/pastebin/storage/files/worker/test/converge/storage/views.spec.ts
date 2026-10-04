import { expect, test } from "vitest"
import { createExecutionContext } from "cloudflare:test"
import type { MetaResponse } from "../../../../shared/interfaces.js"
import { addRole, upload, uploadExpectStatus, workerFetch } from "../../testUtils.js"

async function readMeta(ctx: ExecutionContext, url: string): Promise<MetaResponse> {
  const resp = await workerFetch(ctx, addRole(url, "m"))
  expect(resp.status).toStrictEqual(200)
  return (await resp.json()) as MetaResponse
}

test("a limited paste is deleted after its last view", async () => {
  const ctx = createExecutionContext()
  const uploaded = await upload(ctx, { c: "burn after two views", views: "2" })
  expect(uploaded.maxViews).toStrictEqual(2)
  expect(uploaded.viewsRemaining).toStrictEqual(2)

  // HEAD and metadata reads do not use a view.
  expect((await workerFetch(ctx, new Request(uploaded.url, { method: "HEAD" }))).status).toStrictEqual(200)
  expect((await readMeta(ctx, uploaded.url)).viewsRemaining).toStrictEqual(2)

  const first = await workerFetch(ctx, uploaded.url)
  expect(first.status).toStrictEqual(200)
  expect(await first.text()).toStrictEqual("burn after two views")
  expect(first.headers.get("Cache-Control")).toStrictEqual("no-store")
  expect((await readMeta(ctx, uploaded.url)).viewsRemaining).toStrictEqual(1)

  const second = await workerFetch(ctx, uploaded.url)
  expect(second.status).toStrictEqual(200)
  expect(await second.text()).toStrictEqual("burn after two views")

  expect((await workerFetch(ctx, uploaded.url)).status).toStrictEqual(404)
  expect((await workerFetch(ctx, addRole(uploaded.url, "m"))).status).toStrictEqual(404)
})

test("a paste without a limit has no view fields", async () => {
  const ctx = createExecutionContext()
  const uploaded = await upload(ctx, { c: "no limit" })
  expect(uploaded.maxViews).toBeUndefined()
  for (let i = 0; i < 3; i++) {
    expect((await workerFetch(ctx, uploaded.url)).status).toStrictEqual(200)
  }
  const meta = await readMeta(ctx, uploaded.url)
  expect(meta.viewsRemaining).toBeUndefined()
})

test("the views field accepts only integers from 1 to 1000", async () => {
  const ctx = createExecutionContext()
  for (const views of ["0", "1001", "1.5", "abc", "", "-1"]) {
    await uploadExpectStatus(ctx, { c: "x", views }, 400, { context: `views=${views}` })
  }
  await uploadExpectStatus(ctx, { c: "x", views: "1000" }, 200)
})
