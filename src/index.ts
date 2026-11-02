/**
 * Dedicated Chrome instances with tab-level tools for DeepSeek Harness.
 * Every instance is launched by this plugin with its own profile directory;
 * tabs are leased per agent so concurrent sessions never share one.
 * @module dsh-chrome
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Config } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { ChromeManager } from './manager.ts'
import { locateChrome } from './chrome/locate.ts'
import { registerTools } from './tools/index.ts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin identity. */
export const name = 'dsh-chrome'

/** Services required before tools can be registered. */
export const inject = ['tools']

export { Config }

/**
 * Mount the plugin: create the instance manager, register the browser tools,
 * and wire the agent lifecycle hooks that release leases and close on-demand
 * browsers.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const profileRoot = config.profileRoot.trim() === '' ? dshHomePath('chrome') : config.profileRoot
  const screenshotDir = config.screenshotDir.trim() === ''
    ? join(profileRoot, 'screenshots')
    : config.screenshotDir

  let executable: string | undefined
  const resolveExecutable = (): string => {
    executable ??= locateChrome(config.executablePath)
    return executable
  }

  const manager = new ChromeManager({
    profileRoot,
    screenshotDir,
    resolveExecutable,
    chromeArgs: config.chromeArgs,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    leaseTtlMs: config.leaseTtlMs,
    ephemeralCloseOn: config.ephemeralCloseOn,
    isAgentAlive: (agentId) => {
      const agents = ctx.get('agents')
      // Agent ids are session ids; the registry never holds one for a disposed session.
      return agents === undefined
        ? undefined
        : agents.get(agentId as Parameters<typeof agents.get>[0]) !== undefined
    },
    logger: ctx.logger,
  })

  registerTools(ctx, { manager, screenshotDir })

  ctx.effect(() => async () => {
    await manager.dispose()
  }, 'dsh-chrome.instances')

  ctx.on('agent/disposed', ({ agent }) => {
    manager.releaseAgent(agent.id)
    void manager.closeOwnedBy(agent.id, ['turn', 'session']).catch((error: unknown) => {
      ctx.logger.warn(`dsh-chrome: closing browsers of agent ${agent.id} failed: ${String(error)}`)
    })
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    void manager.closeOwnedBy(agent.id, ['turn']).catch((error: unknown) => {
      ctx.logger.warn(`dsh-chrome: closing turn-scoped browsers failed: ${String(error)}`)
    })
  })
}
