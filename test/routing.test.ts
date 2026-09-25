import { expect, test } from "vitest"
import { SessionRoutes } from "../src/routing.ts"

test("route prefers the thread that owns the active run", () => {
  const routes = new SessionRoutes()
  routes.register("s1", "t1")
  routes.register("s1", "t2")
  const active = new Set(["t2"])
  expect(routes.route("s1", (id) => active.has(id), (id) => (id === "t1" ? 100 : 1))).toBe("t2")
})

test("route falls back to the most recently active thread when none is running", () => {
  const routes = new SessionRoutes()
  routes.register("s1", "t1")
  routes.register("s1", "t2")
  expect(routes.route("s1", () => false, (id) => (id === "t1" ? 50 : 200))).toBe("t2")
  expect(routes.route("s1", () => false, (id) => (id === "t1" ? 300 : 200))).toBe("t1")
})

test("a terminal-originated event with no active run goes to the most recent thread", () => {
  const routes = new SessionRoutes()
  routes.register("s1", "t1")
  expect(routes.route("s1", () => false, () => 10)).toBe("t1")
})

test("unknown sessions route nowhere", () => {
  const routes = new SessionRoutes()
  expect(routes.route("nope", () => false, () => 0)).toBeUndefined()
})

test("forgetThread prunes the route and keeps the session while other threads remain", () => {
  const routes = new SessionRoutes()
  routes.register("s1", "t1")
  routes.register("s1", "t2")
  routes.forgetThread("t2")
  expect(routes.threadsFor("s1")).toEqual(["t1"])
  routes.forgetThread("t1")
  expect(routes.threadsFor("s1")).toEqual([])
  expect(routes.route("s1", () => false, () => 0)).toBeUndefined()
})

test("forgetThreads prunes a whole channel", () => {
  const routes = new SessionRoutes()
  routes.register("s1", "t1")
  routes.register("s2", "t2")
  routes.forgetThreads(["t1", "t2"])
  expect(routes.threadsFor("s1")).toEqual([])
  expect(routes.threadsFor("s2")).toEqual([])
})

test("re-registering a thread moves it to the most recent position", () => {
  const routes = new SessionRoutes()
  routes.register("s1", "t1")
  routes.register("s1", "t2")
  routes.register("s1", "t1")
  expect(routes.threadsFor("s1")).toEqual(["t2", "t1"])
})
