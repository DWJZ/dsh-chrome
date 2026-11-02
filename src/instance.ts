/**
 * One browser instance: a dedicated Chrome process, the MCP engine talking to
 * it, and the leases its tabs are under.
 * @module dsh-chrome/instance
 */

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
    this.chrome = await ensureChrome({
      executablePath: this.options.executablePath,
      profileDir: this.options.profileDir,
      headless: this.options.headless,
      extraArgs: this.options.chromeArgs,
    }, this.options.logger)
    this.engine = await McpEngine.start({
      port: this.chrome.endpoint.port,
      timeoutMs: this.options.toolCallTimeoutMs,
      workspaceDirs: this.options.workspaceDirs,
    })
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
    const pages = await engine.listPages(this.options.toolCallTimeoutMs)
    this.leases.prune(pages.map((page) => page.pageId))
    return pages
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
    return engine.call(name, args, {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.options.toolCallTimeoutMs,
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

  /** Stop the MCP engine and the browser process. */
  async stop(): Promise<void> {
    this.leases.prune([])
    const engine = this.engine
    const chrome = this.chrome
    this.engine = undefined
    this.chrome = undefined
    if (engine !== undefined) await engine.close()
    if (chrome !== undefined) await chrome.close()
  }

  private requireEngine(): McpEngine {
    if (this.engine === undefined) {
      throw new ChromeError('browser_down', `browser "${this.options.name}" is not running; open it first`)
    }
    return this.engine
  }
}
