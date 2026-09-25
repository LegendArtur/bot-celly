import { randomBytes } from "node:crypto"
import type { Config } from "./config.ts"
import type { Db } from "./db.ts"
import type { Project } from "./types.ts"
import { allocatePort, buildSandboxName, isPathInside, Sbx, SbxRunner } from "./sbx.js"
import { buildServeArgs, createClient, waitForHealth } from "./opencode.js"

export interface ProjectDeps {
  sbx: Sbx; runner: SbxRunner; db: Db; config: Config
  log: { info(m: string, f?: any): void; warn(m: string, f?: any): void; error(m: string, f?: any): void; debug(m: string, f?: any): void }
  createChannel(name: string): Promise<string>
  deleteChannel(channelId: string): Promise<void>
  resolveSandboxPath?(name: string): Promise<string>
  isPortFree?(port: number): Promise<boolean>
}

export class ProjectService {
  private children = new Map<string, import("node:child_process").ChildProcess>()
  private inflight = new Map<string, Promise<void>>()
  private intentional = new Set<string>()
  constructor(private readonly deps: ProjectDeps) {}

  childFor(channelId: string): import("node:child_process").ChildProcess | undefined { return this.children.get(channelId) }

  private async isPortFree(port: number): Promise<boolean> {
    if (this.deps.isPortFree) return this.deps.isPortFree(port)
    const { createServer } = await import("node:net")
    return new Promise((resolve) => {
      const srv = createServer()
      srv.once("error", () => resolve(false))
      srv.once("listening", () => srv.close(() => resolve(true)))
      srv.listen(port, "127.0.0.1")
    })
  }

  private killChild(channelId: string): void {
    const child = this.children.get(channelId)
    if (!child) return
    this.children.delete(channelId)
    this.intentional.add(channelId)
    child.kill()
  }

  async addProject(input: { guildId: string; name: string; directory: string; existingChannelId?: string }): Promise<Project> {
    const { config, db, sbx } = this.deps
    if (!isPathInside(config.projectsRoot, input.directory)) throw new Error(`directory must be inside PROJECTS_ROOT (${config.projectsRoot})`)
    const taken = new Set((await sbx.list()).map((s) => s.name))
    for (const p of db.projects.list()) taken.add(p.sandboxName)
    const sandboxName = buildSandboxName(input.name, taken)
    const used = new Set(db.projects.list().map((p) => p.hostPort))
    const hostPort = await allocatePort({ start: config.portRangeStart, end: config.portRangeEnd, used, isFree: (p) => this.isPortFree(p) })
    const serverPassword = randomBytes(16).toString("hex")
    let channelId: string | undefined
    let inserted = false
    try {
      channelId = input.existingChannelId ?? (await this.deps.createChannel(input.name))
      db.projects.insertProvisioning({ channelId, guildId: input.guildId, name: input.name, directory: input.directory,
        sandboxPath: null, sandboxName, hostPort, serverPassword, createdAt: Date.now() })
      inserted = true
      await sbx.create({ name: sandboxName, directory: input.directory, hostPort, cpus: config.sandboxCpus, memory: config.sandboxMemory, template: config.sandboxTemplate })
      await sbx.exec(sandboxName, ["true"])
      const bootstrap = this.deps.resolveSandboxPath ? await this.deps.resolveSandboxPath(sandboxName) : input.directory
      await this.bootServer(channelId)
      const client = createClient(`http://127.0.0.1:${hostPort}`, serverPassword)
      await waitForHealth(client, config.healthTimeoutMs)
      db.projects.setReady(channelId, bootstrap)
      return db.projects.getByChannel(channelId)!
    } catch (e) {
      if (channelId) this.killChild(channelId)
      if (inserted) await sbx.remove(sandboxName).catch(() => {})
      if (inserted && channelId) db.projects.remove(channelId)
      if (!input.existingChannelId && channelId) await this.deps.deleteChannel(channelId).catch(() => {})
      throw e
    }
  }

  private async bootServer(channelId: string): Promise<void> {
    const project = this.deps.db.projects.getByChannel(channelId)
    if (!project) throw new Error(`project ${channelId} not found`)
    if (this.children.get(channelId)) return
    const child = this.deps.sbx.execStream(project.sandboxName, buildServeArgs())
    child.stdout?.on("data", (d) => this.deps.log.debug("project server stdout", { channelId, line: String(d) }))
    child.stderr?.on("data", (d) => this.deps.log.warn("project server stderr", { channelId, line: String(d) }))
    child.on("exit", () => {
      if (this.children.get(channelId) === child) this.children.delete(channelId)
      if (this.intentional.delete(channelId)) return
      this.deps.db.projects.setStatus(channelId, "degraded")
    })
    this.children.set(channelId, child)
  }

  async ensureReady(channelId: string): Promise<void> {
    const existing = this.inflight.get(channelId)
    if (existing) return existing
    const task = (async () => {
      const p = this.deps.db.projects.getByChannel(channelId)
      if (!p) throw new Error(`unknown project ${channelId}`)
      await this.deps.sbx.start(p.sandboxName)
      const client = createClient(`http://127.0.0.1:${p.hostPort}`, p.serverPassword)
      try { await waitForHealth(client, this.deps.config.healthTimeoutMs); return } catch {}
      this.killChild(channelId)
      await this.bootServer(channelId)
      try { await waitForHealth(client, this.deps.config.healthTimeoutMs) }
      catch (e) { throw new Error(`project ${channelId} not healthy: ${(e as Error).message}`) }
    })()
    this.inflight.set(channelId, task.finally(() => this.inflight.delete(channelId)))
    return this.inflight.get(channelId)
  }

  async stop(channelId: string): Promise<void> {
    const p = this.deps.db.projects.getByChannel(channelId); if (!p) return
    this.killChild(channelId)
    await this.deps.sbx.stop(p.sandboxName)
  }

  async remove(channelId: string): Promise<void> {
    const p = this.deps.db.projects.getByChannel(channelId); if (!p) return
    this.killChild(channelId)
    await this.deps.sbx.remove(p.sandboxName).catch(() => {})
    this.deps.db.projects.remove(channelId)
    await this.deps.deleteChannel(channelId).catch(() => {})
  }
}
