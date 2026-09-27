// test/attach.test.ts
import { expect, test } from "vitest"
import { attachCommand, attachReply, createAutoThreadResolver, sessionIdReply } from "../src/attach.ts"

test("attachCommand renders the exact sbx exec opencode attach line", () => {
  expect(attachCommand({ sandboxName: "celly-demo" }, "ses_abc"))
    .toBe("sbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s ses_abc'")
})

test("sessionIdReply shows the bare session id and the command behind a spoiler", () => {
  expect(sessionIdReply({ sandboxName: "celly-demo" }, "ses_abc"))
    .toBe("`ses_abc`\n||sbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s ses_abc'||")
})

test("attachReply wraps the exact command in a code block", () => {
  expect(attachReply({ sandboxName: "celly-demo" }, "ses_abc"))
    .toBe("```\nsbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s ses_abc'\n```")
})

const autoProject = {
  channelId: "c", guildId: "g", name: "demo", directory: "C:\\p", sandboxPath: null,
  sandboxName: "celly-demo", hostPort: 4300, serverPassword: "pw", status: "ready", createdAt: 1,
} as const

test("auto-thread gate drops unknown sessions when disabled", async () => {
  const created: any[] = []
  const resolve = createAutoThreadResolver({
    enabled: false,
    sessionTitle: async () => "terminal work",
    createThread: async (input) => { created.push(input); return { threadId: "t1" } },
    log: { warn: () => {} },
  })
  expect(await resolve(autoProject, "s1")).toBeUndefined()
  expect(created).toEqual([])
})

test("auto-thread gate creates a thread titled by the session title", async () => {
  const created: any[] = []
  const resolve = createAutoThreadResolver({
    enabled: true,
    sessionTitle: async (_project, sessionId) => (sessionId === "s1" ? "terminal work" : undefined),
    createThread: async (input) => { created.push(input); return { threadId: "t1" } },
    log: { warn: () => {} },
  })
  expect(await resolve(autoProject, "s1")).toBe("t1")
  expect(created).toEqual([{ channelId: "c", title: "terminal work", sessionId: "s1" }])
})

test("auto-thread gate falls back to a generated title and drops on lookup failure", async () => {
  const created: any[] = []
  const warns: string[] = []
  const resolve = createAutoThreadResolver({
    enabled: true,
    sessionTitle: async () => undefined,
    createThread: async (input) => { created.push(input); return { threadId: "t1" } },
    log: { warn: (message) => { warns.push(message) } },
  })
  expect(await resolve(autoProject, "s1")).toBe("t1")
  expect(created).toEqual([{ channelId: "c", title: "session s1", sessionId: "s1" }])

  const failing = createAutoThreadResolver({
    enabled: true,
    sessionTitle: async () => { throw new Error("gone") },
    createThread: async () => { throw new Error("must not create") },
    log: { warn: (message) => { warns.push(message) } },
  })
  expect(await failing(autoProject, "s1")).toBeUndefined()
  expect(warns).toEqual(["auto-thread session lookup failed"])
})
