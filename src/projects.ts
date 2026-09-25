import { randomBytes } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Config } from "./config.ts"
import type { Db } from "./db.ts"
import type { Project } from "./types.ts"
import { allocatePort, buildSandboxName, defaultForbiddenPaths, isPathInside, isSensitivePath, sanitizeProjectDirName, Sbx, SbxRunner } from "./sbx.js"
import type { ChildProcess } from "./sbx.js"
import { BOOTSTRAP_SCRIPT, BOOTSTRAP_VERIFY, buildCelyConfigJson, buildOpencodeEnv, buildServeArgs, createClient, waitForHealth } from "./opencode.js"

export interface ProjectDeps {
  sbx: Sbx; runner: SbxRunner; db: Db; config: Config
  log: { info(m: string, f?: any): void; warn(m: string, f?: any): void; error(m: string, f?: any): void; debug(m: string, f?: any): void }
  createChannel(name: string): Promise<string>
  deleteChannel(channelId: string): Promise<void>
  resolveSandboxPath?(name: string): Promise<string>
  isPortFree?(port: number): Promise<boolean>
  forbiddenPaths?: string[]
  onProjectDown?(channelId: string, projectName: string): void
}

export class ProjectService {
  private children = new Map<string, ChildProcess>()
  private inflight = new Map<string, Promise<void>>()
  private intentional = new Set<string>()
  private addQueue: Promise<unknown> = Promise.resolve()
  constructor(private readonly deps: ProjectDeps) {}

  childFor(channelId: string): ChildProcess | undefined { return this.children.get(channelId) }

  async createProjectDirectory(name: string): Promise<string> {
    const directory = join(this.deps.config.projectsRoot, sanitizeProjectDirName(name))
    if (!isPathInside(this.deps.config.projectsRoot, directory)) throw new Error("invalid project directory")
    await mkdir(directory, { recursive: true })
    return directory
  }

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

  private withAddLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.addQueue.then(fn, fn)
    this.addQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private async bootstrapSandbox(sandboxName: string, serverPassword: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "cely-boot-"))
    const configFile = join(dir, "opencode.json")
    const envFile = join(dir, "opencode.env")
    try {
      writeFileSync(configFile, buildCelyConfigJson(), { mode: 0o600 })
      writeFileSync(envFile, buildOpencodeEnv(serverPassword), { mode: 0o600 })
      await this.deps.sbx.cp(configFile, `${sandboxName}:/tmp/cely-opencode.json`)
      await this.deps.sbx.cp(envFile, `${sandboxName}:/tmp/cely-opencode.env`)
      await this.deps.sbx.exec(sandboxName, ["bash", "-lc", BOOTSTRAP_SCRIPT])
      await this.deps.sbx.exec(sandboxName, ["bash", "-lc", BOOTSTRAP_VERIFY])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  addProject(input: { guildId: string; name: string; directory: string; existingChannelId?: string }): Promise<Project> {
    return this.withAddLock(() => this.doAddProject(input))
  }

  private async doAddProject(input: { guildId: string; name: string; directory: string; existingChannelId?: string }): Promise<Project> {
    const { config, db, sbx } = this.deps
    if (!isPathInside(config.projectsRoot, input.directory)) throw new Error(`directory must be inside PROJECTS_ROOT (${config.projectsRoot})`)
    const forbidden = this.deps.forbiddenPaths ?? defaultForbiddenPaths(config.dataDir)
    if (isSensitivePath(input.directory, forbidden)) throw new Error(`directory is too sensitive to mount: ${input.directory}`)
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
      await this.bootstrapSandbox(sandboxName, serverPassword)
      const actualPort = await this.readBackPort(channelId, sandboxName, hostPort)
      const sandboxPath = await this.resolveSandboxPath(channelId, sandboxName, input.directory)
      this.bootServer(channelId)
      const client = createClient(`http://127.0.0.1:${actualPort}`, serverPassword)
      await waitForHealth(client, config.healthTimeoutMs)
      db.projects.setReady(channelId, sandboxPath)
      return db.projects.getByChannel(channelId)!
    } catch (e) {
      if (channelId) this.killChild(channelId)
      if (inserted) await sbx.remove(sandboxName).catch(() => {})
      if (inserted && channelId) db.projects.remove(channelId)
      if (!input.existingChannelId && channelId) await this.deps.deleteChannel(channelId).catch(() => {})
      throw e
    }
  }

  private async readBackPort(channelId: string, sandboxName: string, requested: number): Promise<number> {
    let mappings: Array<{ hostIp: string; hostPort: number; sandboxPort: number; protocol: string }>
    try {
      mappings = await this.deps.sbx.ports(sandboxName)
    } catch (e) {
      this.deps.log.warn("host port read-back failed; using the requested host port", { channelId, requested, error: String(e) })
      return requested
    }
    const mapping = mappings.find((m) => m.sandboxPort === 4096)
    if (!mapping || !Number.isFinite(mapping.hostPort)) {
      this.deps.log.warn("no sandbox 4096 port mapping; using the requested host port", { channelId, requested })
      return requested
    }
    if (mapping.hostPort !== requested) {
      this.deps.log.info("host port read back from sandbox", { channelId, requested, actual: mapping.hostPort })
      this.deps.db.projects.setHostPort(channelId, mapping.hostPort)
    }
    return mapping.hostPort
  }

  private async resolveSandboxPath(channelId: string, sandboxName: string, fallback: string): Promise<string> {
    if (!this.deps.resolveSandboxPath) return fallback
    try {
      return await this.deps.resolveSandboxPath(sandboxName)
    } catch (e) {
      this.deps.log.warn("in-sandbox path resolution failed; falling back to the host directory", { channelId, error: String(e) })
      return fallback
    }
  }

  private bootServer(channelId: string): void {
    const project = this.deps.db.projects.getByChannel(channelId)
    if (!project) throw new Error(`project ${channelId} not found`)
    if (this.children.get(channelId)) return
    const child = this.deps.sbx.execStream(project.sandboxName, buildServeArgs())
    const logFile = join(this.deps.config.dataDir, "logs", `${project.sandboxName}.log`)
    try { mkdirSync(dirname(logFile), { recursive: true }) } catch {}
    const appendLog = (prefix: string, data: unknown): void => { try { appendFileSync(logFile, `[${prefix}] ${String(data)}`) } catch {} }
    child.stdout?.on("data", (d) => { appendLog("out", d); this.deps.log.debug("project server stdout", { channelId, line: String(d) }) })
    child.stderr?.on("data", (d) => { appendLog("err", d); this.deps.log.warn("project server stderr", { channelId, line: String(d) }) })
    child.on("exit", () => {
      const tracked = this.children.get(channelId) === child
      if (tracked) this.children.delete(channelId)
      if (this.intentional.delete(channelId)) return
      if (!tracked) return
      this.deps.db.projects.setStatus(channelId, "degraded")
      this.deps.onProjectDown?.(channelId, project.name)
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
      let healthy = false
      try { await waitForHealth(client, this.deps.config.healthTimeoutMs); healthy = true } catch {}
      if (healthy) {
        this.deps.db.projects.setStatus(channelId, "ready")
        if (!this.children.has(channelId)) this.bootServer(channelId)
        return
      }
      this.killChild(channelId)
      this.bootServer(channelId)
      try { await waitForHealth(client, this.deps.config.healthTimeoutMs) }
      catch (e) { throw new Error(`project ${channelId} not healthy: ${(e as Error).message}`) }
      this.deps.db.projects.setStatus(channelId, "ready")
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
