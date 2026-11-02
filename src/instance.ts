/**
 * One browser instance: a dedicated Chrome process, the MCP engine talking to
 * it, and the leases its tabs are under.
 * @module dsh-chrome/instance
 */

import { rm } from 'node:fs/promises'
import { ensureChrome } from './chrome/process.ts'
import type { LaunchLogger, RunningChrome } from './chrome/process.ts'
import { ChromeError } from './errors.ts'
import { LeaseBook } from './leases.ts'
import type { AgentLiveness } from './leases.ts'
import { McpEngine } from './mcp/engine.ts'
import type { McpResult, McpPage } from './mcp/engine.ts'
import type { CloseOn } from './config.ts'

/** Construction parameters for one instance. */
export interface InstanceOptions {
  /** Agent-chosen instance name; also the profile directory name. */
  readonly name: string
  /** Start the browser without a window. */
  readonly headless: boolean
  /** Profile directory holding cookies and logins. */
  readonly profileDir: string
  /** When this instance releases its Chrome process. */
  readonly closeOn: CloseOn
  /** Agent that created an on-demand instance, when any. */
  readonly ownerAgentId?: string
  /** Chrome executable. */
  readonly executablePath: string
  /** Extra Chrome arguments. */
  readonly chromeArgs: readonly string[]
  /** Directories the MCP server may read and write. */
  readonly workspaceDirs: readonly string[]
  /** Bound on one MCP call. */
  readonly toolCallTimeoutMs: number
  /** Fallback lease expiry. */
  readonly leaseTtlMs: number
  /** Agent liveness probe for lease sweeping. */
  readonly isAgentAlive: AgentLiveness
  /** Diagnostics sink. */
  readonly logger: LaunchLogger
}

/**
 * A dedicated browser owned by this plugin. Tabs are serialized per page so a
 * long operation never interleaves with another call on the same tab.
 */
export class BrowserInstance {
  /** Claims on this instance's tabs. */
  readonly leases: LeaseBook
  private chrome: RunningChrome | undefined
  private engine: McpEngine | undefined
  private readonly chains = new Map<number, Promise<unknown>>()

  /** @param options - identity, filesystem location, and call bounds. */
  constructor(readonly options: InstanceOptions) {
    this.leases = new LeaseBook(options.leaseTtlMs, options.isAgentAlive)
  }

  /** Instance name used by every browser-scoped tool. */
  get name(): string {
    return this.options.name
  }

  /** Whether the browser starts without a window. */
  get headless(): boolean {
    return this.options.headless
  }

  /** Agent that created this instance, when it is on demand. */
  get ownerAgentId(): string | undefined {
    return this.options.ownerAgentId
  }

  /** Close policy recorded when the instance was created. */
  get closeOn(): CloseOn {
    return this.options.closeOn
  }

  /** Start Chrome and the MCP engine when they are not running yet. */
  async start(): Promise<void> {
    if (this.engine !== undefined) return
    this.chrome ??= await ensureChrome({
      executablePath: this.options.executablePath,
      profileDir: this.options.profileDir,
      headless: this.options.headless,
      extraArgs: this.options.chromeArgs,
    }, this.options.logger)
    await this.startEngine()
  }

  /** Whether both processes are up. */
  get running(): boolean {
    return this.engine !== undefined
  }

  /** DevTools port, when running. */
  get port(): number | undefined {
    return this.chrome?.endpoint.port
  }

  /**
   * List this browser's pages and drop leases for pages that disappeared.
   * @returns the live pages.
   */
  async pages(): Promise<McpPage[]> {
    const engine = this.requireEngine()
    try {
      const pages = await engine.listPages(this.options.toolCallTimeoutMs)
      this.leases.prune(pages.map((page) => page.pageId))
      return pages
    } catch (error) {
      return this.recover(error)
    }
  }

  /**
   * Call one upstream tool on this browser.
   * @param name - upstream tool name.
   * @param args - upstream arguments.
   * @param signal - caller cancellation.
   * @returns the MCP payload.
   */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult> {
    const engine = this.requireEngine()
    try {
      return await engine.call(name, args, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.options.toolCallTimeoutMs,
      })
    } catch (error) {
      return this.recover(error)
    }
  }

  /**
   * Restart a dead MCP server for later calls, then rethrow this call's failure.
   * Page ids do not survive the restart, so the call cannot be retried silently.
   * @param error - the failure to translate or rethrow.
   * @returns never.
   */
  private async recover(error: unknown): Promise<never> {
    if (!isTransportFailure(error)) throw error
    const engine = this.engine
    this.engine = undefined
    this.leases.prune([])
    await engine?.close().catch(() => {})
    await this.startEngine().catch(() => {})
    throw new ChromeError(
      'browser_down',
      `browser "${this.options.name}": the MCP server restarted, so page ids changed; call chrome_list_tabs again`,
    )
  }

  /** Start the MCP engine against the running browser. */
  private async startEngine(): Promise<void> {
    if (this.chrome === undefined) return
    this.engine = await McpEngine.start({
      port: this.chrome.endpoint.port,
      timeoutMs: this.options.toolCallTimeoutMs,
      workspaceDirs: this.options.workspaceDirs,
    })
  }

  /**
   * Run work for one tab after that tab's earlier work settles.
   * @param pageId - the tab whose queue this work joins.
   * @param work - the operation to run.
   * @returns the operation result.
   */
  async serial<T>(pageId: number, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(pageId) ?? Promise.resolve()
    const current = previous.then(work, work)
    this.chains.set(pageId, current.catch(() => undefined))
    return current
  }

  /** Stop the MCP engine and the browser process; headless profiles are discarded. */
  async stop(): Promise<void> {
    this.leases.prune([])
    const engine = this.engine
    const chrome = this.chrome
    this.engine = undefined
    this.chrome = undefined
    if (engine !== undefined) await engine.close()
    if (chrome !== undefined) await chrome.close()
    if (this.options.headless) await rm(this.options.profileDir, { recursive: true, force: true })
  }

  private requireEngine(): McpEngine {
    if (this.engine === undefined) {
      throw new ChromeError('browser_down', `browser "${this.options.name}" is not running; open it first`)
    }
    return this.engine
  }
}

/**
 * Whether a failed call means the MCP server process is gone rather than the
 * browser rejecting the operation.
 * @param error - any thrown value.
 * @returns true when the transport, not the tool, failed.
 */
function isTransportFailure(error: unknown): boolean {
  if (error instanceof ChromeError) return false
  const code = readStringProperty(error, 'code')
  if (code !== undefined && /CONNECTION_CLOSED|CONNECTION_LOST|EPIPE|ECONNRESET|EPROTO/i.test(code)) return true
  const message = error instanceof Error ? error.message : String(error)
  return /connection closed|not connected|transport closed|socket hang up|EPIPE|ECONNRESET/i.test(message)
}

/**
 * Read one string property from an unknown thrown value.
 * @param value - candidate error.
 * @param key - property name.
 * @returns the property when it is a string.
 */
function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const property = (value as Record<string, unknown>)[key]
  return typeof property === 'string' ? property : undefined
}
