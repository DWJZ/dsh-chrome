/**
 * Lease book for tabs. A tab belongs to one agent at a time; expiry exists only
 * as a fallback for owners this process can no longer resolve.
 * @module dsh-chrome/leases
 */

import { ChromeError } from './errors.ts'

/** One agent's claim on one page. */
export interface Lease {
  /** Identifier of the owning agent. */
  readonly agentId: string
  /** When the claim was last refreshed. */
  readonly at: number
}

/** Resolve whether an agent still exists; undefined means "cannot tell". */
export type AgentLiveness = (agentId: string) => boolean | undefined

/** Claims held for one browser instance, keyed by the MCP page id. */
export class LeaseBook {
  private readonly leases = new Map<number, Lease>()

  /**
   * @param ttlMs - fallback expiry for claims whose owner cannot be resolved.
   * @param isAlive - agent liveness probe; undefined when the agent service is absent.
   * @param now - clock, injected for tests.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly isAlive: AgentLiveness,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read the current owner of a page after sweeping expired claims.
   * @param pageId - MCP page id.
   * @returns the owning agent id, or undefined when the page is free.
   */
  owner(pageId: number): string | undefined {
    this.sweep()
    return this.leases.get(pageId)?.agentId
  }

  /**
   * Claim a page for an agent, refreshing a claim it already holds.
   * @param pageId - MCP page id.
   * @param agentId - caller identity.
   * @throws {ChromeError} `tab_busy` when another live agent holds the page.
   */
  claim(pageId: number, agentId: string): void {
    this.sweep()
    const existing = this.leases.get(pageId)
    if (existing !== undefined && existing.agentId !== agentId) {
      throw new ChromeError(
        'tab_busy',
        `tab ${pageId} is held by another session (${existing.agentId}); use another tab or ask that session to release_tab`,
      )
    }
    this.leases.set(pageId, { agentId, at: this.now() })
  }

  /**
   * Release one page.
   * @param pageId - MCP page id.
   */
  release(pageId: number): void {
    this.leases.delete(pageId)
  }

  /**
   * Release every page held by one agent.
   * @param agentId - agent whose claims end.
   * @returns how many claims were released.
   */
  releaseAgent(agentId: string): number {
    let released = 0
    for (const [pageId, lease] of this.leases) {
      if (lease.agentId !== agentId) continue
      this.leases.delete(pageId)
      released += 1
    }
    return released
  }

  /** Drop claims whose page no longer exists. */
  prune(pages: readonly number[]): void {
    const live = new Set(pages)
    for (const pageId of this.leases.keys()) {
      if (!live.has(pageId)) this.leases.delete(pageId)
    }
  }

  /** Every current claim, newest first is not guaranteed. */
  entries(): [number, Lease][] {
    this.sweep()
    return [...this.leases.entries()]
  }

  /** Remove claims whose owner is gone, or whose fallback lifetime elapsed. */
  sweep(): void {
    const at = this.now()
    for (const [pageId, lease] of this.leases) {
      const alive = this.isAlive(lease.agentId)
      if (alive === false) {
        this.leases.delete(pageId)
        continue
      }
      if (alive === undefined && at - lease.at > this.ttlMs) this.leases.delete(pageId)
    }
  }
}
