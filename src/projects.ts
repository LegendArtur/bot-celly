import { randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, mkdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Config } from "./config.ts"
import type { Db } from "./db.ts"
import type { Project } from "./types.ts"
import { allocatePort, buildSandboxName, defaultForbiddenPaths, isPathInside, isSensitivePath, sanitizeProjectDirName, Sbx, SbxRunner } from "./sbx.js"
import type { ChildProcess } from "./sbx.js"
import { applyAndAssertCellyPolicy, BOOTSTRAP_PREPARE, BOOTSTRAP_VERIFY, buildBootstrapInstallScript, buildServeArgs, createClient, waitForHealth } from "./opencode.js"
import type { OpencodeClient } from "./opencode.js"
import { redact } from "./log.js"

export interface ProjectDeps {
  sbx: Sbx; runner: SbxRunner; db: Db; config: Config
  log: { info(m: string, f?: any): void; warn(m: string, f?: any): void; error(m: string, f?: any): void; debug(m: string, f?: any): void }
  createChannel(name: string): Promise<string>
  deleteChannel(channelId: string): Promise<void>
  resolveSandboxPath?(name: string): Promise<string>
  isPortFree?(port: number): Promise<boolean>
  forbiddenPaths?: string[]
  onProjectDown?(channelId: string, projectName: string): void
  onProjectMissing?(channelId: string, projectName: string): void
  onProjectReady?(project: Project): void
  applyPolicy?(client: OpencodeClient): Promise<void>
  killTimeoutMs?: number
}

function isLoopbackHost(hostIp: string | undefined): boolean {
  const ip = (hostIp ?? "127.0.0.1").replace(/^\[|\]$/g, "").toLowerCase()
  return ip === "127.0.0.1" || ip === "localhost" || ip === "::1" || ip === "0:0:0:0:0:0:0:1"
}

export class ProjectService {
  private children = new Map<string, ChildProcess>()
  private adopted = new Set<string>()
  private inflight = new Map<string, Promise<void>>()
  private intentional = new Set<ChildProcess>()
  private killTimers = new Map<ChildProcess, ReturnType<typeof setTimeout>>()
  private addQueue: Promise<unknown> = Promise.resolve()
  constructor(private readonly deps: ProjectDeps) {}

  childFor(channelId: string): ChildProcess | undefined { return this.children.get(channelId) }
  isAdopted(channelId: string): boolean { return this.adopted.has(channelId) }

  private validateDirectory(directory: string): void {
    const { config } = this.deps
    if (!isPathInside(config.projectsRoot, directory)) throw new Error(`directory must be inside PROJECTS_ROOT (${config.projectsRoot})`)
    const forbidden = this.deps.forbiddenPaths ?? defaultForbiddenPaths(config.dataDir)
    if (isSensitivePath(directory, forbidden)) throw new Error(`directory is too sensitive to mount: ${directory}`)
  }

  async createProjectDirectory(name: string): Promise<string> {
    const directory = join(this.deps.config.projectsRoot, sanitizeProjectDirName(name))
    this.validateDirectory(directory)
    await mkdir(directory, { recursive: true })
    return directory
  }

  private applyPolicy(client: OpencodeClient): Promise<void> {
    return (this.deps.applyPolicy ?? (applyAndAssertCellyPolicy as (c: OpencodeClient) => Promise<void>))(client)
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
    this.adopted.delete(channelId)
    const child = this.children.get(channelId)
    if (!child) return
    this.children.delete(channelId)
    this.intentional.add(child)
    const timer = setTimeout(() => {
      this.intentional.delete(child)
      this.killTimers.delete(child)
    }, this.deps.killTimeoutMs ?? 5000)
    if (typeof (timer as any).unref === "function") (timer as any).unref()
    this.killTimers.set(child, timer)
    child.kill()
  }

  private withAddLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.addQueue.then(fn, fn)
    this.addQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private async runBootstrap(sandboxName: string, serverPassword: string): Promise<void> {
    // The sandbox user writes its own config/env (content on stdin, 0600 via
    // umask). No host temp files, no sandbox /tmp, no root-owned `sbx cp`.
    await this.deps.sbx.exec(sandboxName, ["bash", "-lc", BOOTSTRAP_PREPARE])
    await this.deps.sbx.execWithInput(sandboxName, ["bash", "-s"], buildBootstrapInstallScript(serverPassword))
    await this.deps.sbx.exec(sandboxName, ["bash", "-lc", BOOTSTRAP_VERIFY])
  }

  // Spec §14: a transient `sbx cp`/bootstrap failure gets one retry before the
  // saga rolls the sandbox back.
  private async bootstrapSandbox(sandboxName: string, serverPassword: string): Promise<void> {
    try {
      await this.runBootstrap(sandboxName, serverPassword)
    } catch (first) {
      this.deps.log.warn("sandbox bootstrap failed; retrying once", { sandboxName, error: String(first) })
      await this.runBootstrap(sandboxName, serverPassword)
    }
  }

  addProject(
    input: { guildId: string; name: string; directory: string; existingChannelId?: string },
    onProgress?: (stage: string) => void | Promise<void>,
  ): Promise<Project> {
    return this.withAddLock(() => this.doAddProject(input, onProgress))
  }

  private async report(onProgress: ((stage: string) => void | Promise<void>) | undefined, stage: string): Promise<void> {
    if (!onProgress) return
    try { await onProgress(stage) } catch (e) { this.deps.log.warn("project progress callback failed", { stage, error: String(e) }) }
  }

  private async doAddProject(
    input: { guildId: string; name: string; directory: string; existingChannelId?: string },
    onProgress?: (stage: string) => void | Promise<void>,
  ): Promise<Project> {
    const { config, db, sbx } = this.deps
    this.validateDirectory(input.directory)
    const listed = await sbx.list()
    const taken = new Set(listed.map((s) => s.name))
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
      await this.report(onProgress, "creating sandbox…")
      await sbx.create({ name: sandboxName, directory: input.directory, hostPort, cpus: config.sandboxCpus, memory: config.sandboxMemory, template: config.sandboxTemplate })
      await sbx.exec(sandboxName, ["true"])
      await this.report(onProgress, "installing…")
      await this.bootstrapSandbox(sandboxName, serverPassword)
      await this.report(onProgress, "starting server…")
      const actualPort = await this.readBackPort(channelId, sandboxName, hostPort)
      const sandboxPath = await this.resolveSandboxPath(channelId, sandboxName, input.directory)
      const child = this.bootServer(channelId)
      const client = createClient(`http://127.0.0.1:${actualPort}`, serverPassword)
      await this.waitForServer(client, config.bootTimeoutMs, child, sandboxName)
      await this.applyPolicy(client)
      db.projects.setReady(channelId, sandboxPath)
      this.deps.onProjectReady?.(db.projects.getByChannel(channelId)!)
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
      mappings = await this.deps.sbx.ports(sandboxName, { timeoutMs: 15_000 })
    } catch (e) {
      this.deps.log.warn("host port read-back failed; using the requested host port", { channelId, requested, error: String(e) })
      return requested
    }
    const mapping = mappings.find((m) => m.sandboxPort === 4096 && isLoopbackHost(m.hostIp))
    if (!mapping || !Number.isFinite(mapping.hostPort)) {
      this.deps.log.warn("no loopback sandbox 4096 port mapping; using the requested host port", { channelId, requested })
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

  private async isSandboxMissing(sandboxName: string): Promise<boolean> {
    try {
      const list = await this.deps.sbx.list()
      return !list.some((s) => s.name === sandboxName)
    } catch {
      return false
    }
  }

  /**
   * Spec §7: the persisted host port can drift when a sandbox is recreated.
   * Read the live mapping, persist it, and best-effort re-publish a missing
   * 4096 mapping under a timeout (re-publish can prompt on conflict).
   */
  private async reconcileHostPort(channelId: string, p: Project): Promise<number> {
    let mappings: Array<{ hostIp?: string; hostPort: number; sandboxPort: number }> = []
    try { mappings = await this.deps.sbx.ports(p.sandboxName) } catch { return p.hostPort }
    const mapping = mappings.find((m) => m.sandboxPort === 4096 && isLoopbackHost(m.hostIp))
    if (mapping && Number.isFinite(mapping.hostPort)) {
      if (mapping.hostPort !== p.hostPort) {
        this.deps.log.info("host port mapping reconciled at wake", { channelId, stored: p.hostPort, actual: mapping.hostPort })
        this.deps.db.projects.setHostPort(channelId, mapping.hostPort)
      }
      return mapping.hostPort
    }
    this.deps.log.warn("sandbox 4096 mapping missing; re-publishing best-effort", { channelId, hostPort: p.hostPort })
    try {
      await this.deps.sbx.publish(p.sandboxName, `${p.hostPort}:4096`, { timeoutMs: 15_000 })
      const again = await this.deps.sbx.ports(p.sandboxName)
      const remapped = again.find((m) => m.sandboxPort === 4096 && isLoopbackHost(m.hostIp))
      if (remapped && Number.isFinite(remapped.hostPort)) {
        if (remapped.hostPort !== p.hostPort) this.deps.db.projects.setHostPort(channelId, remapped.hostPort)
        return remapped.hostPort
      }
    } catch (e) {
      this.deps.log.warn("sandbox port re-publish failed", { channelId, error: String(e) })
    }
    return p.hostPort
  }

  /** `/project start`: wake the sandbox, recreating it via the create path if gone. */
  async start(channelId: string): Promise<void> {
    const p = this.deps.db.projects.getByChannel(channelId)
    if (!p) throw new Error(`unknown project ${channelId}`)
    if (await this.isSandboxMissing(p.sandboxName)) return this.recreate(channelId)
    return this.ensureReady(channelId)
  }

  private recreate(channelId: string): Promise<void> {
    return this.withAddLock(() => this.doRecreate(channelId))
  }

  private async doRecreate(channelId: string): Promise<void> {
    const { config, db, sbx } = this.deps
    const p = db.projects.getByChannel(channelId)
    if (!p) throw new Error(`unknown project ${channelId}`)
    this.validateDirectory(p.directory)
    db.projects.setStatus(channelId, "provisioning")
    // Spec §12: credentials rotate when a sandbox is recreated.
    const serverPassword = randomBytes(16).toString("hex")
    db.projects.setServerPassword(channelId, serverPassword)
    try {
      await sbx.create({ name: p.sandboxName, directory: p.directory, hostPort: p.hostPort, cpus: config.sandboxCpus, memory: config.sandboxMemory, template: config.sandboxTemplate })
      await sbx.exec(p.sandboxName, ["true"])
      await this.bootstrapSandbox(p.sandboxName, serverPassword)
      const actualPort = await this.readBackPort(channelId, p.sandboxName, p.hostPort)
      const sandboxPath = await this.resolveSandboxPath(channelId, p.sandboxName, p.directory)
      this.killChild(channelId)
      this.bootServer(channelId)
      const client = createClient(`http://127.0.0.1:${actualPort}`, serverPassword)
      await waitForHealth(client, config.bootTimeoutMs)
      await this.applyPolicy(client)
      db.projects.setReady(channelId, sandboxPath)
      this.deps.onProjectReady?.(db.projects.getByChannel(channelId)!)
    } catch (e) {
      this.killChild(channelId)
      await sbx.remove(p.sandboxName).catch(() => {})
      db.projects.setStatus(channelId, "degraded")
      throw e
    }
  }

  private bootServer(channelId: string): ChildProcess {
    const project = this.deps.db.projects.getByChannel(channelId)
    if (!project) throw new Error(`project ${channelId} not found`)
    const existing = this.children.get(channelId)
    if (existing) return existing
    this.adopted.delete(channelId)
    const child = this.deps.sbx.execStream(project.sandboxName, buildServeArgs())
    const logFile = join(this.deps.config.dataDir, "logs", `${project.sandboxName}.log`)
    try { mkdirSync(dirname(logFile), { recursive: true }) } catch {}
    try { chmodSync(logFile, 0o600) } catch {}
    const logSecrets = [project.serverPassword]
    const appendLog = (prefix: string, data: unknown): void => {
      try { appendFileSync(logFile, redact(`[${prefix}] ${String(data)}`, logSecrets), { mode: 0o600 }) } catch {}
    }
    child.stdout?.on("data", (d) => { appendLog("out", d); this.deps.log.debug("project server stdout", { channelId, line: String(d) }) })
    child.stderr?.on("data", (d) => { appendLog("err", d); this.deps.log.warn("project server stderr", { channelId, line: String(d) }) })
    child.on("exit", () => {
      const tracked = this.children.get(channelId) === child
      if (tracked) this.children.delete(channelId)
      const killTimer = this.killTimers.get(child)
      if (killTimer !== undefined) { clearTimeout(killTimer); this.killTimers.delete(child) }
      if (this.intentional.delete(child)) return
      if (!tracked) return
      this.deps.db.projects.setStatus(channelId, "degraded")
      this.deps.onProjectDown?.(channelId, project.name)
    })
    this.children.set(channelId, child)
    return child
  }

  /**
   * Fail fast if the supervised serve child dies during startup instead of
   * waiting out the full health timeout. The child's output is in the project
   * log file, named in the error.
   */
  private async waitForServer(
    client: OpencodeClient,
    timeoutMs: number,
    child: ChildProcess,
    sandboxName: string,
  ): Promise<void> {
    const logFile = join(this.deps.config.dataDir, "logs", `${sandboxName}.log`)
    let onExit: (() => void) | undefined
    const exited = new Promise<never>((_, reject) => {
      onExit = () => reject(new Error(`opencode serve exited during startup; see ${logFile}`))
      child.on("exit", onExit)
    })
    void exited.catch(() => {})
    try {
      await Promise.race([waitForHealth(client, timeoutMs), exited])
    } finally {
      if (onExit) child.off?.("exit", onExit)
    }
  }

  async ensureReady(channelId: string): Promise<void> {
    const existing = this.inflight.get(channelId)
    if (existing) return existing
    const task = (async () => {
      // Serialize behind the create saga: a prompt that lands while the project
      // is still provisioning must not race the sandbox it is waiting on.
      await this.addQueue
      const p = this.deps.db.projects.getByChannel(channelId)
      if (!p) throw new Error(`unknown project ${channelId}`)
      if (p.status === "provisioning") throw new Error(`project ${channelId} is still provisioning`)
      try {
        await this.deps.sbx.start(p.sandboxName)
      } catch (e) {
        if (await this.isSandboxMissing(p.sandboxName)) {
          this.deps.db.projects.setStatus(channelId, "degraded")
          this.deps.onProjectMissing?.(channelId, p.name)
          throw new Error(`sandbox ${p.sandboxName} is missing; run /project start to recreate it`)
        }
        throw e
      }
      const hostPort = await this.reconcileHostPort(channelId, p)
      const client = createClient(`http://127.0.0.1:${hostPort}`, p.serverPassword)
      let healthy = false
      try { await waitForHealth(client, this.deps.config.healthTimeoutMs); healthy = true } catch {}
      if (healthy) {
        // Re-assert the policy: a project opencode.json may have weakened the
        // bootstrap config, and a newly woken server starts from files again.
        await this.applyPolicy(client)
        this.deps.db.projects.setStatus(channelId, "ready")
        // A healthy server with no tracked child is an orphan from a previous
        // bot process; adopt it rather than spawning a second one that would
        // fail to bind and flip the project to degraded.
        if (!this.children.has(channelId)) this.adopted.add(channelId)
        return
      }
      this.killChild(channelId)
      this.bootServer(channelId)
      try {
        await waitForHealth(client, this.deps.config.healthTimeoutMs)
        await this.applyPolicy(client)
      }
      catch (e) {
        this.killChild(channelId)
        throw new Error(`project ${channelId} not healthy: ${(e as Error).message}`)
      }
      this.deps.db.projects.setStatus(channelId, "ready")
    })()
    this.inflight.set(channelId, task.finally(() => this.inflight.delete(channelId)))
    return this.inflight.get(channelId)
  }

  async health(channelId: string, timeoutMs = 3000): Promise<boolean> {
    const p = this.deps.db.projects.getByChannel(channelId)
    if (!p) return false
    try {
      const client = createClient(`http://127.0.0.1:${p.hostPort}`, p.serverPassword)
      await waitForHealth(client, timeoutMs, 250)
      return true
    } catch {
      return false
    }
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
