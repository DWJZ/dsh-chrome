/**
 * Dedicated Chrome instances with tab-level tools for DeepSeek Harness.
 * Every instance is launched by this plugin with its own profile directory;
 * tabs are leased per agent so concurrent sessions never share one.
 * @module dsh-chrome
 */

import { resolveConfig, dshHome } from './config.ts'
import type { Config } from './config.ts'
import { ChromeManager } from './manager.ts'
import { locateChrome } from './chrome/locate.ts'
import { registerTools } from './tools/index.ts'
import type { ToolDefinition } from './tool-contract.ts'

/** Cordis plugin identity. */
export const name = 'dsh-chrome'

/** Services required before tools can be registered. */
export const inject = ['tools']

/** Diagnostics sink the host provides. */
interface PluginLogger {
  info(message: string): void
  warn(message: string): void
}

/** Payload of the agent lifecycle events this plugin consumes. */
interface AgentLifecyclePayload {
  agent: { id: string }
}

/** Agent registry lookup used for lease liveness. */
interface AgentRegistryLike {
  get(id: string): unknown
}

/** The host facilities this plugin uses, declared locally so the package installs without the harness. */
export interface PluginContext {
  logger: PluginLogger
  tools: { register(definition: ToolDefinition): () => void }
  effect(body: () => () => Promise<void>, label?: string): unknown
  on(event: string, listener: (payload: AgentLifecyclePayload) => void): unknown
  get(service: 'agents'): AgentRegistryLike | undefined
}

/**
 * Mount the plugin: create the instance manager, register the browser tools,
 * and wire the agent lifecycle hooks that release leases and close on-demand
 * browsers.
 * @param ctx - plugin context.
 * @param config - plugin configuration as written in the profile patch.
 */
export function apply(ctx: PluginContext, config: Config = {}): void {
  const resolved = resolveConfig(config, dshHome())
  const { profileRoot, screenshotDir } = resolved

  let executable: string | undefined
  const resolveExecutable = (): string => {
    executable ??= locateChrome(resolved.executablePath)
    return executable
  }

  const manager = new ChromeManager({
    profileRoot,
    defaultProfile: resolved.defaultProfile,
    screenshotDir,
    resolveExecutable,
    chromeArgs: resolved.chromeArgs,
    toolCallTimeoutMs: resolved.toolCallTimeoutMs,
    leaseTtlMs: resolved.leaseTtlMs,
    ephemeralCloseOn: resolved.ephemeralCloseOn,
    isAgentAlive: (agentId) => {
      const agents = ctx.get('agents')
      return agents === undefined ? undefined : agents.get(agentId) !== undefined
    },
    logger: ctx.logger,
  })

  registerTools(ctx, { manager, screenshotDir })

  void manager.reapOrphans().then((reaped) => {
    if (reaped.length > 0) ctx.logger.info(`dsh-chrome: cleaned up ${reaped.length} leftover headless browser(s): ${reaped.join(', ')}`)
  }, (error: unknown) => {
    ctx.logger.warn(`dsh-chrome: leftover headless cleanup failed: ${String(error)}`)
  })

  ctx.effect(() => async () => {
    await manager.dispose()
  }, 'dsh-chrome.instances')

  ctx.on('agent/disposed', ({ agent }) => {
    manager.releaseAgent(agent.id)
    void manager.closeOwnedBy(agent.id, ['turn', 'session'])
      .then(async ({ closed, kept }) => {
        if (kept.length > 0) ctx.logger.info(`dsh-chrome: keeping ${kept.join(', ')} open, other sessions hold tabs`)
        const abandoned = await manager.closeAbandoned()
        const stopped = [...closed, ...abandoned]
        if (stopped.length > 0) ctx.logger.info(`dsh-chrome: closed browsers ${stopped.join(', ')}`)
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`dsh-chrome: closing browsers of agent ${agent.id} failed: ${String(error)}`)
      })
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    void manager.closeOwnedBy(agent.id, ['turn'])
      .then(({ closed, kept }) => {
        if (kept.length > 0) ctx.logger.info(`dsh-chrome: keeping ${kept.join(', ')} open, other sessions hold tabs`)
        if (closed.length > 0) ctx.logger.info(`dsh-chrome: closed turn-scoped browsers ${closed.join(', ')}`)
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`dsh-chrome: closing turn-scoped browsers failed: ${String(error)}`)
      })
  })
}

