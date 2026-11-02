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

/** State of a name that is already registered. */
export interface ExistingInstance {
  /** Whether its browser still answers. */
  alive: boolean
  /** Profile it runs on, or null when throwaway. */
  profile: string | null
}

/** What opening a name should do before any browser work happens. */
export type OpenDecision =
  /** No instance holds the name. */
  | { kind: 'create' }
  /** The instance is gone; drop its record and start a new one. */
  | { kind: 'replace' }
  /** A headed instance is open; hand it back. */
  | { kind: 'reuse' }
  /** A headless instance holds the name; headless names are exclusive. */
  | { kind: 'duplicate' }
  /** The open instance runs on another profile than the caller named explicitly. */
  | { kind: 'profile-conflict'; profile: string | null }

/**
 * Decide what an open request does with a name that may already be taken.
 *
 * Headed browsers are shared: the same name hands back the running browser, so
 * sessions split one window into tabs. Headless browsers are exclusive to their
 * instance: a live name is a conflict and the caller must pick another.
 * @param existing - instance already registered under the name, when any.
 * @param options - headless choice and the profile the caller asked for.
 * @param defaultProfile - profile headed instances use when none is named.
 * @returns the action to take.
 */
export function decideOpen(
  existing: ExistingInstance | undefined,
  options: Pick<OpenOptions, 'headless' | 'profile' | 'ephemeral'>,
  defaultProfile: string,
): OpenDecision {
  if (existing === undefined) return { kind: 'create' }
  if (!existing.alive) return { kind: 'replace' }
  if (options.headless) return { kind: 'duplicate' }
  const requestedProfile = options.profile?.trim() ?? ''
  const explicit = options.ephemeral === true || requestedProfile !== ''
  if (!explicit) return { kind: 'reuse' }
  const requested = options.ephemeral === true
    ? null
    : requestedProfile === '' ? defaultProfile : requestedProfile
  return existing.profile === requested ? { kind: 'reuse' } : { kind: 'profile-conflict', profile: existing.profile }
}

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
   * Open a browser.
   *
   * A headed name that is already open returns that instance, so several
   * sessions reach one browser and split it into tabs. A headless name is
   * exclusive: a live one is refused and the caller must pick another.
   * @param name - agent-chosen instance name.
   * @param options - headless choice, profile choice, and owning agent.
   * @returns the instance and whether it was already open.
   * @throws {ChromeError} `instance_exists` for a live headless name, `profile_busy` when a
   *   headed name is open on another profile than the caller explicitly asked for.
   */
  async open(name: string, options: OpenOptions): Promise<OpenResult> {
    if (!NAME_PATTERN.test(name)) {
      throw new ChromeError('instance_exists', `invalid instance name "${name}"; use letters, digits, - and _ (max 32)`)
    }
    const decision = await this.decide(name, options)
    if (decision.kind === 'duplicate') {
      throw new ChromeError(
        'instance_exists',
        `headless browser "${name}" is already open; headless instances are not shared, pick another name`,
      )
    }
    if (decision.kind === 'profile-conflict') {
      throw new ChromeError(
        'profile_busy',
        `browser "${name}" is already open on profile "${decision.profile ?? 'ephemeral'}"; close it, or pick another name`,
      )
    }
    if (decision.kind === 'reuse') {
      const existing = this.instances.get(name)
      if (existing !== undefined) return { instance: existing, reused: true }
    }
    if (decision.kind === 'replace') {
      const dead = this.instances.get(name)
      if (dead !== undefined) {
        this.options.logger.info(`dsh-chrome: replacing browser "${name}", its process is gone`)
        this.forget(dead)
        await dead.stop().catch(() => {})
      }
    }

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
   *
   * An instance another session is still using stays open: a lease held by
   * someone else outranks the owner's close policy. It is closed later by
   * {@link closeAbandoned} once that session is gone and its leases are freed.
   * @param agentId - owning agent.
   * @param policies - close policies to apply.
   * @returns names stopped and names kept because another session holds a tab.
   */
  async closeOwnedBy(agentId: string, policies: readonly CloseOn[]): Promise<{ closed: string[]; kept: string[] }> {
    const closed: string[] = []
    const kept: string[] = []
    for (const [name, instance] of [...this.instances]) {
      if (instance.ownerAgentId !== agentId) continue
      if (!policies.includes(instance.closeOn)) continue
      if (this.hasForeignLease(instance)) {
        kept.push(name)
        continue
      }
      this.forget(instance)
      await instance.stop()
      closed.push(name)
    }
    return { closed, kept }
  }

  /**
   * Stop on-demand instances whose owner is gone and whose tabs nobody holds.
   *
   * This is what finally closes an instance `closeOwnedBy` kept alive for
   * another session, after that session released its tabs.
   * @returns names of the stopped instances.
   */
  async closeAbandoned(): Promise<string[]> {
    const closed: string[] = []
    for (const [name, instance] of [...this.instances]) {
      if (instance.closeOn === 'manual') continue
      const owner = instance.ownerAgentId
      if (owner === undefined) continue
      if (this.options.isAgentAlive(owner) !== false) continue
      if (this.hasForeignLease(instance)) continue
      this.forget(instance)
      await instance.stop()
      closed.push(name)
    }
    return closed
  }

  /**
   * Whether a session other than the instance's owner still holds a tab.
   * @param instance - instance whose leases are inspected.
   * @returns true when some other caller owns a lease.
   */
  private hasForeignLease(instance: BrowserInstance): boolean {
    return instance.leases.entries().some(([, lease]) => lease.agentId !== instance.ownerAgentId)
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
   * Read what opening this name should do.
   * @param name - instance name the caller wants.
   * @param options - requested headless and profile choice.
   * @returns the decision from {@link decideOpen}.
   */
  private async decide(name: string, options: OpenOptions): Promise<OpenDecision> {
    const existing = this.instances.get(name)
    if (existing === undefined) return { kind: 'create' }
    return decideOpen(
      { alive: await existing.isAlive(), profile: existing.profile },
      options,
      this.options.defaultProfile,
    )
  }

  /**
   * Resolve which profile a new instance runs on.
   *
   * Headless instances are isolated unless the caller names a profile, so they
   * never collide with the headed browser and its logins.
   * @param options - requested headless and profile choice.
   * @returns the profile to use.
   */
  private profileChoice(options: OpenOptions): ProfileChoice {
    if (options.ephemeral === true) return { kind: 'ephemeral' }
    const requested = options.profile?.trim()
    if ((requested === undefined || requested === '') && options.headless) return { kind: 'ephemeral' }
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
