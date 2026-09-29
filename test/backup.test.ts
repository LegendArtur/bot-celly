import { DatabaseSync } from "node:sqlite"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, test } from "vitest"
import { createBackupScheduler } from "../src/backup.ts"
import { openDb } from "../src/db.ts"
import { projectFixture } from "./helpers/fixtures.ts"
import { withTempDir } from "./helpers/tmp.ts"

const proj = projectFixture({ channelId: "c1", guildId: "g1", directory: "C:\\p\\demo" })

test("tick writes a VACUUM INTO backup that opens as SQLite", async () => {
  await withTempDir("celly-backup-", async (dir) => {
    const db = openDb(join(dir, "bot.db"))
    db.migrate()
    db.projects.insertProvisioning(proj)
    try {
      const out = join(dir, "backups")
      const scheduler = createBackupScheduler({ db, dir: out, intervalMs: 0, keep: 3, now: () => 1_700_000_000_000 })
      const file = await scheduler.tick()
      expect(file).toBe(join(out, "bot-2023-11-14T22-13-20-000Z.db"))
      const backup = new DatabaseSync(file!)
      expect((backup.prepare("SELECT name FROM projects").get() as any).name).toBe("demo")
      backup.close()
    } finally {
      db.close()
    }
  })
})

test("a quote in the backup directory path is escaped", async () => {
  await withTempDir("celly-back'up-", async (dir) => {
    const db = openDb(join(dir, "bot.db"))
    db.migrate()
    try {
      const out = join(dir, "back'ups")
      const scheduler = createBackupScheduler({ db, dir: out, intervalMs: 0, keep: 1, now: () => 0 })
      const file = await scheduler.tick()
      const backup = new DatabaseSync(file!)
      expect((backup.prepare("SELECT count(*) AS n FROM projects").get() as any).n).toBe(0)
      backup.close()
    } finally {
      db.close()
    }
  })
})

test("resolves a relative backup dir against cwd and prunes backups", async () => {
  await withTempDir("celly-rel-backup-", async (base) => {
    const db = openDb(join(base, "bot.db"))
    db.migrate()
    db.projects.insertProvisioning(proj)
    try {
      const relDir = relative(process.cwd(), join(base, "backups"))
      let clock = 1_700_000_000_000
      const scheduler = createBackupScheduler({ db, dir: relDir, intervalMs: 0, keep: 2, now: () => clock })
      clock += 1000; const first = await scheduler.tick()
      expect(first).toBe(join(base, "backups", "bot-2023-11-14T22-13-21-000Z.db"))
      const backup = new DatabaseSync(first!)
      expect((backup.prepare("SELECT name FROM projects").get() as any).name).toBe("demo")
      backup.close()
      clock += 1000; await scheduler.tick()
      clock += 1000; await scheduler.tick()
      const names = readdirSync(join(base, "backups")).sort()
      expect(names).toHaveLength(2)
    } finally {
      db.close()
    }
  })
})

test("prune keeps only the newest backups", async () => {
  await withTempDir("celly-backup-", async (dir) => {
    const db = openDb(join(dir, "bot.db"))
    db.migrate()
    try {
      const out = join(dir, "backups")
      let clock = 1_700_000_000_000
      const scheduler = createBackupScheduler({ db, dir: out, intervalMs: 0, keep: 2, now: () => clock })
      clock += 1000; await scheduler.tick()
      clock += 1000; await scheduler.tick()
      clock += 1000; await scheduler.tick()
      const names = readdirSync(out).sort()
      expect(names).toHaveLength(2)
      expect(names[0]).toContain("2023-11-14T22-13-22")
      expect(names[1]).toContain("2023-11-14T22-13-23")
    } finally {
      db.close()
    }
  })
})
