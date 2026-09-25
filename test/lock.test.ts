import { expect, test } from "vitest"
import { acquireLock } from "../src/lock.ts"

test("second lock attempt fails and release frees it", async () => {
  const a = await acquireLock(4555)
  await expect(acquireLock(4555)).rejects.toThrow(/already running/)
  a.release()
  const b = await acquireLock(4555); b.release()
})
