import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

export interface TestServer {
  url: string
  port: number
  close(): Promise<void>
}

export async function startTestServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}
