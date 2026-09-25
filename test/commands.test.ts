// test/commands.test.ts
import { expect, test } from "vitest"
import { commandData, handleCommand } from "../src/commands.ts"
import { openDb } from "../src/db.ts"

test("declares the v1 command set", () => {
  const names = commandData().map((c) => c.name).sort()
  expect(names).toEqual(["abort", "agent", "model", "new", "project", "resume"])
})
test("project has the expected subcommands", () => {
  const project = commandData().find((c) => c.name === "project")!
  const subs = project.options.map((o: any) => o.name).sort()
  expect(subs).toEqual(["add", "create", "list", "remove", "start", "status", "stop"])
})
test("handleCommand defers and answers status", async () => {
  const calls: string[] = []
  const interaction = { commandName: "project", options: { getSubcommand: () => "status", getString: () => "demo" },
    deferReply: async () => { calls.push("defer") }, editReply: async (c: string) => { calls.push("edit:" + c) }, reply: async () => {} }
  const db = openDb(":memory:"); db.migrate()
  db.projects.insertProvisioning({ channelId: "c", guildId: "g", name: "demo", directory: "C:\\p", sandboxPath: null, sandboxName: "cely-demo", hostPort: 4300, serverPassword: "pw", createdAt: 1 })
  db.projects.setReady("c", "C:\\p")
  await handleCommand(interaction, { projects: {} as any, runner: {} as any, db, authorized: () => true })
  expect(calls[0]).toBe("defer")
  expect(calls[1]).toMatch(/ready/)
})
