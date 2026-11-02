/**
 * Instance registry: starts, reuses, and stops dedicated browsers, and applies
 * the close policy each instance was created with.
 *
 * Chrome permits one process per profile directory, so instances that share a
 * profile run one after another: an open instance owns its profile until it
 * closes, and a second instance asking for the same profile is refused.
 * @module dsh-chrome/manager
 */

import type { Dirent } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ChromeError } from './errors.ts'
import { BrowserInstance } from './instance.ts'
import type { CloseOn } from './config.ts'
import { readInstanceState, readProfileMarker, terminateProcess } from './chrome/process.ts'
import type { LaunchLogger } from './chrome/process.ts'
import type { AgentLiveness } from './leases.ts'

/** Name every browser-scoped tool uses when the caller names none. */
export const DEFAULT_BROWSER = 'default'

/** Which profile directory a new instance runs on. */
export type ProfileChoice =
  /** A named profile shared by every instance that asks for it. */
  | { kind: 'profile'; name: string }
  /** A throwaway profile deleted with the instance. */
  | { kind: 'ephemeral' }

/** Construction parameters shared by every instance this manager creates. */
export interface ManagerOptions {
  /** Root holding the profile and ephemeral directories. */
  readonly profileRoot: string
  /** Profile every instance uses unless it asks for another or none. */
  readonly defaultProfile: string
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
  profile: string | null
  running: boolean
  open: boolean
  status: 'up' | 'down'
  port: number | null
  closeOn: CloseOn
  owner: string | null
  tabs: number | null
  error: string | null
}

/** What opening one instance needs beyond its name. */
export interface OpenOptions {
  /** Start without a window. */
  headless: boolean
  /** Shared profile to use; omitted means {@link ManagerOptions.defaultProfile}. */
  profile?: string
  /** Use a throwaway profile instead of any shared one. */
  ephemeral?: boolean
  /** Agent creating the instance, for its close policy. */
  ownerAgentId?: string
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** Outcome of an open request. */
export type OpenResult = {
  /** The instance to use; the already-open one when the name was taken. */
  instance: BrowserInstance
  /** Whether an already-open instance was returned instead of starting one. */
  reused: boolean
}

/** Owns every browser instance of this plugin. */
export class ChromeManager {
  private readonly instances = new Map<string, BrowserInstance>()
  /** Profile directory currently owned by an open instance. */
  private readonly profileOwners = new Map<string, string>()

  /** @param options - filesystem roots and call bounds shared by instances. */
  constructor(private readonly options: ManagerOptions) {}

  /**
   * Open a browser. A name that is already open returns that instance, so
   * several sessions reach one browser and split it into tabs.
   * @param name - agent-chosen instance name.
   * @param options - headless choice, profile choice, and owning agent.
   * @returns the instance and whether it was already open.
   * @throws {ChromeError} `profile_busy` when this name is open on a different profile than
   *   the caller explicitly asked for, otherwise startup failures.
   */
  async open(name: string, options: OpenOptions): Promise<OpenResult> {
    if (!NAME_PATTERN.test(name)) {
      throw new ChromeError('instance_exists', `invalid instance name "${name}"; use letters, digits, - and _ (max 32)`)
    }
    const existing = await this.reusable(name, options)
    if (existing !== undefined) return { instance: existing, reused: true }

    const choice = this.profileChoice(options)
    const profileDir = this.profileDir(name, choice)
    const holder = this.profileOwners.get(profileDir)
    if (holder !== undefined && holder !== name) {
      throw new ChromeError(
        'profile_busy',
        `profile "${choice.kind === 'profile' ? choice.name : 'ephemeral'}" is in use by browser "${holder}"; `
        + `use that browser, close it, or open with ephemeral: true`,
      )
    }

    const executablePath = this.options.resolveExecutable()
    const instance = new BrowserInstance({
      name,
      headless: options.headless,
      profile: choice.kind === 'profile' ? choice.name : null,
      profileDir,
      closeOn: options.headless ? this.options.ephemeralCloseOn : 'manual',
      ...(options.ownerAgentId === undefined ? {} : { ownerAgentId: options.ownerAgentId }),
      executablePath,
      workspaceDirs: [this.options.screenshotDir],
      chromeArgs: this.options.chromeArgs,
      toolCallTimeoutMs: this.options.toolCallTimeoutMs,
      leaseTtlMs: this.options.leaseTtlMs,
      isAgentAlive: this.options.isAgentAlive,
      logger: this.options.logger,
    })
    this.instances.set(name, instance)
    this.profileOwners.set(profileDir, name)
    try {
      await instance.start()
    } catch (error) {
      this.instances.delete(name)
      this.profileOwners.delete(profileDir)
      throw error
    }
    return { instance, reused: false }
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
    this.forget(instance)
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
      this.forget(instance)
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
   * Remove persistent profiles and throwaway browsers a previous host left behind.
   *
   * Shared profiles are never touched: their logins are the point. Ephemeral
   * directories, and legacy per-instance directories, are removed.
   * @returns directory names that were cleaned up.
   */
  async reapOrphans(): Promise<string[]> {
    const reaped: string[] = []
    const ephemeralRoot = join(this.options.profileRoot, 'ephemeral')
    for (const [dir, label] of [...(await this.candidateOrphans()), ...(await this.listDir(ephemeralRoot))]) {
      if (await this.reapOne(dir, label)) reaped.push(label)
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
      let status: 'up' | 'down' = 'up'
      try {
        tabs = (await instance.pages()).length
      } catch (failure) {
        status = 'down'
        error = failure instanceof Error ? failure.message : String(failure)
      }
      summaries.push({
        name: instance.name,
        headless: instance.headless,
        profile: instance.profile,
        running: instance.running && status === 'up',
        open: true,
        status,
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
    this.profileOwners.clear()
    await Promise.allSettled(instances.map(async (instance) => instance.stop()))
  }

  /** Drop an instance from both maps. */
  private forget(instance: BrowserInstance): void {
    this.instances.delete(instance.name)
    this.profileOwners.delete(instance.profileDir)
  }

  /**
   * Return an instance already open under this name, or drop the dead one.
   *
   * Opening the same name again is how several sessions reach one browser, so
   * a live instance wins over the requested options; only a profile the caller
   * named explicitly and that differs is a real conflict.
   * @param name - instance name the caller wants.
   * @param options - requested profile choice.
   * @returns the live instance, or undefined when the caller must start a new one.
   * @throws {ChromeError} `profile_busy` when the caller named a different profile.
   */
  private async reusable(name: string, options: OpenOptions): Promise<BrowserInstance | undefined> {
    const existing = this.instances.get(name)
    if (existing === undefined) return undefined
    if (!await existing.isAlive()) {
      this.options.logger.info(`dsh-chrome: replacing browser "${name}", its process is gone`)
      this.forget(existing)
      await existing.stop().catch(() => {})
      return undefined
    }
    const explicit = options.ephemeral === true || (options.profile?.trim() ?? '') !== ''
    const requested = options.ephemeral === true
      ? null
      : (options.profile?.trim() ?? '') === '' ? this.options.defaultProfile : options.profile?.trim() ?? ''
    if (explicit && existing.profile !== requested) {
      throw new ChromeError(
        'profile_busy',
        `browser "${name}" is already open on profile "${existing.profile ?? 'ephemeral'}"; close it, or pick another name`,
      )
    }
    return existing
  }

  /** Resolve the requested profile choice. */
  private profileChoice(options: OpenOptions): ProfileChoice {
    if (options.ephemeral === true) return { kind: 'ephemeral' }
    const requested = options.profile?.trim()
    const name = requested === undefined || requested === '' ? this.options.defaultProfile : requested
    if (!NAME_PATTERN.test(name)) {
      throw new ChromeError('instance_exists', `invalid profile name "${name}"; use letters, digits, - and _ (max 32)`)
    }
    return { kind: 'profile', name }
  }

  /** Directory holding one instance's Chrome data. */
  private profileDir(instanceName: string, choice: ProfileChoice): string {
    return choice.kind === 'profile'
      ? join(this.options.profileRoot, 'profiles', choice.name)
      : join(this.options.profileRoot, 'ephemeral', instanceName)
  }

  /** Directories left behind by older layouts, still reaped when they were headless. */
  private async candidateOrphans(): Promise<[string, string][]> {
    const legacy: [string, string][] = []
    for (const entry of await this.listDir(this.options.profileRoot)) {
      const [dir] = entry
      const name = dir.slice(dir.lastIndexOf('/') + 1)
      if (name === 'profiles' || name === 'ephemeral' || name === 'screenshots') continue
      legacy.push(entry)
    }
    return legacy
  }

  /** Read one directory as [path, name] pairs, tolerating a missing root. */
  private async listDir(root: string): Promise<[string, string][]> {
    let entries: Dirent[]
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.isDirectory() && !this.instances.has(entry.name))
      .map((entry) => [join(root, entry.name), entry.name])
  }

  /** Stop and remove one leftover directory when it is headless. */
  private async reapOne(dir: string, label: string): Promise<boolean> {
    const headless = (await readProfileMarker(dir)) ?? (await readInstanceState(dir))?.headless
    if (headless !== true) return false
    const state = await readInstanceState(dir)
    if (state !== undefined) await terminateProcess(state.pid)
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      this.options.logger.warn(`dsh-chrome: could not remove leftover profile ${dir}: ${String(error)}`)
      return false
    }
    return true
  }
}
