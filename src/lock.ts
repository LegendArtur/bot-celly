import { createServer } from "node:net"
export function acquireLock(port: number): Promise<{ release(): void }> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", () => reject(new Error(`Celly is already running (lock port ${port})`)))
    srv.listen(port, "127.0.0.1", () => resolve({ release: () => srv.close() }))
  })
}
