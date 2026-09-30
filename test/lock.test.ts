import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { expect, test } from "vitest"
import { acquireLock } from "../src/lock.ts"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address() as AddressInfo
      srv.close(() => resolve(address.port))
    })
  })
}

test("second lock attempt fails and release frees it", async () => {
  const port = await freePort()
  const a = await acquireLock(port)
  await expect(acquireLock(port)).rejects.toThrow(/already running/)
  a.release()
  const b = await acquireLock(port); b.release()
})
