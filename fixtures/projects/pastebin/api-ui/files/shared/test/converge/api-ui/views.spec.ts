import { expect, test } from "vitest"
import { formatViewsRemaining, parseViews, viewsRemainingOf } from "../../../parsers.js"

test("parseViews accepts only integers from 1 to 1000", () => {
  expect(parseViews("1")).toStrictEqual(1)
  expect(parseViews(" 25 ")).toStrictEqual(25)
  expect(parseViews("1000")).toStrictEqual(1000)
  for (const bad of ["", "0", "1001", "1.5", "-1", "abc", "1e2"]) {
    expect(parseViews(bad)).toBeNull()
  }
})

test("viewsRemainingOf reads the field only when it is a count", () => {
  expect(viewsRemainingOf({ viewsRemaining: 3 })).toStrictEqual(3)
  expect(viewsRemainingOf({ viewsRemaining: 0 })).toStrictEqual(0)
  expect(viewsRemainingOf({})).toBeUndefined()
  expect(viewsRemainingOf({ viewsRemaining: "3" })).toBeUndefined()
  expect(viewsRemainingOf({ viewsRemaining: -1 })).toBeUndefined()
})

test("formatViewsRemaining shows a count or unlimited", () => {
  expect(formatViewsRemaining(2)).toStrictEqual("Remaining views: 2")
  expect(formatViewsRemaining(undefined)).toStrictEqual("Remaining views: unlimited")
})
