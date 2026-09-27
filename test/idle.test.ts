// test/idle.test.ts
import { expect, test, vi } from "vitest"
import { createIdleSweeper, formatIdleStopNotice } from "../src/idle.ts"
import type { IdleSweeperDeps } from "../src/idle.ts"
import type { Project } from "../src/types.ts"

const MINUTE = 60_000

const project = (over: Partial<Project> = {}): Project => ({
  channelId: "c1", guildId: "g", name: "demo", directory: "C:\\p", sandboxPath: null,
  sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", status: "ready",
  createdAt: 1, lastActiveAt: MINUTE, ...over,
})

function makeSweeper(over: Partial<IdleSweeperDeps> = {}) {
  const stops: string[] = []
  const notices: Array<{ channelId: string; minutes: number }> = []
  const deps: IdleSweeperDeps = {
    listProjects: () => [project()],
    activeThreads: () => [],
    now: () => 31 * MINUTE,
    stop: (channelId) => { stops.push(channelId) },
    notify: (channelId, minutes) => { notices.push({ channelId, minutes }) },
    idleMs: 30 * MINUTE,
    intervalMs: 1000,
    ...over,
  }
  return { sweeper: createIdleSweeper(deps), stops, notices }
}

test("stops and notifies a project idle past the threshold", async () => {
  const { sweeper, stops, notices } = makeSweeper()
  await sweeper.tick()
  expect(stops).toEqual(["c1"])
  expect(notices).toEqual([{ channelId: "c1", minutes: 30 }])
})

test("skips a project that has never recorded activity", async () => {
  const { sweeper, stops, notices } = makeSweeper({ listProjects: () => [project({ lastActiveAt: 0 })] })
  await sweeper.tick()
  expect(stops).toEqual([])
  expect(notices).toEqual([])
})

test("clamps the notified minutes to the configured threshold", async () => {
  const { sweeper, notices } = makeSweeper({
    idleMs: 30 * MINUTE,
    now: () => 10 * 60 * MINUTE,
    listProjects: () => [project({ lastActiveAt: MINUTE })],
  })
  await sweeper.tick()
  expect(notices).toEqual([{ channelId: "c1", minutes: 30 }])
})

test("skips a project with an active run", async () => {
  const { sweeper, stops, notices } = makeSweeper({ activeThreads: () => ["t1"] })
  await sweeper.tick()
  expect(stops).toEqual([])
  expect(notices).toEqual([])
})

test("skips a provisioning project", async () => {
  const { sweeper, stops } = makeSweeper({ listProjects: () => [project({ status: "provisioning" })] })
  await sweeper.tick()
  expect(stops).toEqual([])
})

test("does not stop a project that was active within the window", async () => {
  const { sweeper, stops } = makeSweeper({ listProjects: () => [project({ lastActiveAt: 29 * MINUTE })] })
  await sweeper.tick()
  expect(stops).toEqual([])
})

test("a touch resets the idle clock", async () => {
  let lastActiveAt = MINUTE
  const { sweeper, stops } = makeSweeper({ listProjects: () => [project({ lastActiveAt })] })
  await sweeper.tick()
  expect(stops).toEqual(["c1"])
  lastActiveAt = 31 * MINUTE
  await sweeper.tick()
  expect(stops).toEqual(["c1"])
})

test("idleMs 0 is a no-op: start schedules no timer and tick stops nothing", async () => {
  vi.useFakeTimers()
  try {
    const { sweeper, stops, notices } = makeSweeper({ idleMs: 0 })
    sweeper.start()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    await sweeper.tick()
    expect(stops).toEqual([])
    expect(notices).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})

test("formatIdleStopNotice pluralizes the idle window", () => {
  expect(formatIdleStopNotice(1)).toContain("1 minute of inactivity")
  expect(formatIdleStopNotice(31)).toContain("31 minutes of inactivity")
})

test("start schedules one unref'd interval and stop clears it", async () => {
  vi.useFakeTimers()
  try {
    let now = 0
    const stops: string[] = []
    const sweeper = createIdleSweeper({
      listProjects: () => [project({ lastActiveAt: 1 })],
      activeThreads: () => [],
      now: () => now,
      stop: (channelId) => { stops.push(channelId) },
      notify: () => {},
      idleMs: MINUTE,
      intervalMs: 1000,
    })
    now = 2 * MINUTE
    sweeper.start()
    sweeper.start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(stops).toEqual(["c1"])
    sweeper.stop()
    expect(vi.getTimerCount()).toBe(0)
    now = 5 * MINUTE
    await vi.advanceTimersByTimeAsync(3000)
    expect(stops).toEqual(["c1"])
  } finally {
    vi.useRealTimers()
  }
})
