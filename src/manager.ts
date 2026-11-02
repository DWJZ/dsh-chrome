/**
 * Instance registry: starts, reuses, and stops dedicated browsers, and applies
 * the close policy each instance was created with.
 * @module dsh-chrome/manager
 */

import type { Dirent } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ChromeError } from './errors.ts'
import { BrowserInstance } from './instance.ts'
import type { CloseOn } from './config.ts'
import { readInstanceState, terminateProcess } from './chrome/process.ts'
import type { LaunchLogger } from './chrome/process.ts'
import type { AgentLiveness } from './leases.ts'

/** Name every browser-scoped tool uses when the caller names none. */
export const DEFAULT_BROWSER = 'default'

/** Construction parameters shared by every instance this manager creates. */
export interface ManagerOptions {
  /** Root holding one directory per instance. */
  readonly profileRoot: string
  /** Directory receiving screenshots. */
  readonly screenshotDir: string
  /** Resolve the Chrome executable on first use, so a missing browser fails a tool instead of the profile. */
  readonly resolveExecutable: () => string
  /** Extra Chrome arguments. */
  readonly chromeArgs: readonly string[]
  /** Bound on one MCP call. */
  readonly toolCallTimeoutMs: number
  /** Fallback lease expiry. */
  readonly leaseTtlMs: number
  /** Default close policy for headless instances. */
  readonly ephemeralCloseOn: CloseOn
  /** Agent liveness probe handed to every lease book. */
  readonly isAgentAlive: AgentLiveness
  /** Diagnostics sink. */
  readonly logger: LaunchLogger
}

/** Summary of one instance for `chrome_browser_list`. */
export type InstanceSummary = {
  name: string
  headless: boolean
  running: boolean
  open: boolean
  port: number | null
  closeOn: CloseOn
  owner: string | null
  tabs: number | null
  error: string | null
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** Owns every browser instance of this plugin. */
export class ChromeManager {
  private readonly instances = new Map<string, BrowserInstance>()

  /** @param options - filesystem roots and call bounds shared by instances. */
  constructor(private readonly options: ManagerOptions) {}

  /**
   * Open a browser, or fail when the name is taken.
   * @param name - agent-chosen instance name.
   * @param headless - start without a window.
   * @param ownerAgentId - agent creating the instance, for its close policy.
   * @returns the started instance.
   * @throws {ChromeError} `instance_exists` on a duplicate name, otherwise startup failures.
   */
  async open(name: string, headless: boolean, ownerAgentId: string | undefined): Promise<BrowserInstance> {
    if (!NAME_PATTERN.test(name)) {
      throw new ChromeError('instance_exists', `invalid instance name "${name}"; use letters, digits, - and _ (max 32)`)
    }
    const existing = this.instances.get(name)
    if (existing !== undefined) {
      throw new ChromeError(
        'instance_exists',
        `browser "${name}" already exists; pick another name or reuse it with browser="${name}"`,
      )
    }
    const executablePath = this.options.resolveExecutable()
    const instance = new BrowserInstance({
      name,
      headless,
      profileDir: join(this.options.profileRoot, name),
      closeOn: headless ? this.options.ephemeralCloseOn : 'manual',
      ...(ownerAgentId === undefined ? {} : { ownerAgentId }),
      executablePath,
      workspaceDirs: [this.options.screenshotDir],
      chromeArgs: this.options.chromeArgs,
      toolCallTimeoutMs: this.options.toolCallTimeoutMs,
      leaseTtlMs: this.options.leaseTtlMs,
      isAgentAlive: this.options.isAgentAlive,
      logger: this.options.logger,
    })
    this.instances.set(name, instance)
    try {
      await instance.start()
    } catch (error) {
      this.instances.delete(name)
      throw error
    }
    return instance
  }

  /**
   * Resolve a running instance.
   * @param name - instance name; defaults to {@link DEFAULT_BROWSER}.
   * @returns the instance.
   * @throws {ChromeError} `instance_gone` when no such instance is open.
   */
  require(name: string | undefined): BrowserInstance {
    const resolved = name ?? DEFAULT_BROWSER
    const instance = this.instances.get(resolved)
    if (instance === undefined) {
      const known = [...this.instances.keys()]
      throw new ChromeError(
        'instance_gone',
        known.length === 0
          ? `no browser is open; call chrome_browser_open first (browser "${resolved}" was requested)`
          : `browser "${resolved}" is not open; open instances: ${known.join(', ')}`,
      )
    }
    return instance
  }

  /**
   * Stop one browser.
   * @param name - instance name.
   * @returns whether an instance was stopped.
   */
  async close(name: string): Promise<boolean> {
    const instance = this.instances.get(name)
    if (instance === undefined) return false
    this.instances.delete(name)
    await instance.stop()
    return true
  }

  /**
   * Stop every instance an agent created under a given close policy.
   * @param agentId - owning agent.
   * @param policies - close policies to apply.
   * @returns names of the stopped instances.
   */
  async closeOwnedBy(agentId: string, policies: readonly CloseOn[]): Promise<string[]> {
    const closed: string[] = []
    for (const [name, instance] of [...this.instances]) {
      if (instance.ownerAgentId !== agentId) continue
      if (!policies.includes(instance.closeOn)) continue
      this.instances.delete(name)
      await instance.stop()
      closed.push(name)
    }
    return closed
  }

  /**
   * Release every lease an agent holds across all instances.
   * @param agentId - agent whose claims end.
   */
  releaseAgent(agentId: string): void {
    for (const instance of this.instances.values()) instance.leases.releaseAgent(agentId)
  }

  /**
   * Stop headless browsers left behind by a previous host process.
   *
   * A headless profile is on demand by definition, so at plugin load no live
   * agent can own one.
   * @returns names of the profiles that were cleaned up.
   */
  async reapOrphans(): Promise<string[]> {
    const reaped: string[] = []
    let entries: Dirent[]
    try {
      entries = await readdir(this.options.profileRoot, { withFileTypes: true })
    } catch {
      return reaped
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || this.instances.has(entry.name)) continue
      const dir = join(this.options.profileRoot, entry.name)
      const state = await readInstanceState(dir)
      if (state === undefined || !state.headless) continue
      await terminateProcess(state.pid)
      await rm(dir, { recursive: true, force: true })
      reaped.push(entry.name)
    }
    return reaped
  }

  /**
   * Describe every open instance, with its tab count when reachable.
   * @returns one summary per instance.
   */
  async list(): Promise<InstanceSummary[]> {
    const summaries: InstanceSummary[] = []
    for (const instance of this.instances.values()) {
      let tabs: number | null = null
      let error: string | null = null
      try {
        tabs = (await instance.pages()).length
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
      }
      summaries.push({
        name: instance.name,
        headless: instance.headless,
        running: instance.running,
        open: true,
        port: instance.port ?? null,
        closeOn: instance.closeOn,
        owner: instance.ownerAgentId ?? null,
        tabs,
        error,
      })
    }
    return summaries
  }

  /** Stop every instance and close their processes. */
  async dispose(): Promise<void> {
    const instances = [...this.instances.values()]
    this.instances.clear()
    await Promise.allSettled(instances.map(async (instance) => instance.stop()))
  }
}
