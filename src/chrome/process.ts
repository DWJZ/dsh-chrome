/**
 * Dedicated Chrome processes. Launching uses `--no-startup-window`, so the
 * browser starts without taking focus; the first page is created afterwards
 * through CDP with `background: true`.
 * @module dsh-chrome/chrome/process
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cdpCommand,
  devToolsActivePortFile,
  listTargets,
  probeDevTools,
  readDevToolsActivePort,
  waitFor,
} from './cdp.ts'
import type { DevToolsEndpoint } from './cdp.ts'
import { ChromeError } from '../errors.ts'

/** Startup parameters for one dedicated browser. */
export interface ChromeLaunchSpec {
  /** Executable resolved by {@link locateChrome}. */
  executablePath: string
  /** Profile directory, unique per instance. */
  profileDir: string
  /** Start the browser without a visible window. */
  headless: boolean
  /** Extra command-line arguments appended after the plugin's own. */
  extraArgs: readonly string[]
}

/** A running browser this plugin owns. */
export interface RunningChrome {
  /** Main browser process id. */
  readonly pid: number
  /** DevTools endpoint the browser published. */
  readonly endpoint: DevToolsEndpoint
  /** Stop the process and remove its state file. */
  close(): Promise<void>
}

/** Minimal logger surface used here. */
export interface LaunchLogger {
  info(message: string): void
  warn(message: string): void
}

interface InstanceState {
  pid: number
  startedAt: string
  headless: boolean
}

const STATE_FILE = '.dsh-chrome-instance.json'
const STARTUP_TIMEOUT_MS = 30000

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readState(profileDir: string): Promise<InstanceState | undefined> {
  try {
    const text = await readFile(join(profileDir, STATE_FILE), 'utf8')
    const parsed = JSON.parse(text) as Partial<InstanceState>
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return undefined
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      headless: parsed.headless === true,
    }
  } catch {
    return undefined
  }
}

/**
 * Reuse a browser this plugin already started for the same profile.
 * @param profileDir - profile directory to inspect.
 * @returns the running browser, or undefined when none answers.
 */
export async function adoptChrome(profileDir: string): Promise<RunningChrome | undefined> {
  const state = await readState(profileDir)
  if (state === undefined) return undefined
  if (!isAlive(state.pid)) {
    await rm(join(profileDir, STATE_FILE), { force: true })
    return undefined
  }
  const published = await readDevToolsActivePort(profileDir)
  const endpoint = published === undefined ? undefined : await probeDevTools(published.port)
  if (endpoint === undefined) return undefined
  return runningChrome(state.pid, endpoint, profileDir)
}

function runningChrome(pid: number, endpoint: DevToolsEndpoint, profileDir: string): RunningChrome {
  return {
    pid,
    endpoint,
    async close(): Promise<void> {
      await stopProcess(pid)
      await forgetChrome(profileDir)
    },
  }
}

async function stopProcess(pid: number): Promise<void> {
  if (!isAlive(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const gone = await waitFor(async () => (isAlive(pid) ? undefined : true), 5000)
  if (gone !== undefined) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The process exited between the liveness check and the signal.
  }
  await waitFor(async () => (isAlive(pid) ? undefined : true), 3000)
}

/**
 * Start a dedicated browser, or reuse the one already running this profile.
 * @param spec - executable, profile directory, and headless choice.
 * @param logger - diagnostics sink.
 * @returns the owned browser with its discovered DevTools endpoint.
 * @throws {ChromeError} `browser_down` when Chrome never publishes an endpoint.
 */
export async function ensureChrome(spec: ChromeLaunchSpec, logger: LaunchLogger): Promise<RunningChrome> {
  const adopted = await adoptChrome(spec.profileDir)
  if (adopted !== undefined) {
    logger.info(`dsh-chrome: reusing Chrome for ${spec.profileDir} on port ${adopted.endpoint.port}`)
    return adopted
  }
  await mkdir(spec.profileDir, { recursive: true })
  await rm(join(spec.profileDir, STATE_FILE), { force: true })
  await rm(devToolsActivePortFile(spec.profileDir), { force: true })

  const args = [
    `--user-data-dir=${spec.profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-startup-window',
    ...(spec.headless ? ['--headless=new'] : []),
    ...spec.extraArgs,
  ]
  const child = spawn(spec.executablePath, args, { detached: true, stdio: 'ignore' })
  child.unref()
  const pid = child.pid
  if (pid === undefined) throw new ChromeError('browser_down', 'Chrome failed to start')

  const endpoint = await waitFor(async () => {
    if (!isAlive(pid)) return undefined
    const published = await readDevToolsActivePort(spec.profileDir)
    if (published === undefined) return undefined
    return await probeDevTools(published.port)
  }, STARTUP_TIMEOUT_MS)
  if (endpoint === undefined) {
    await stopProcess(pid)
    throw new ChromeError('browser_down', `Chrome did not publish a DevTools endpoint within ${STARTUP_TIMEOUT_MS}ms`)
  }

  await ensureFirstPage(endpoint, logger)
  const state: InstanceState = { pid, startedAt: new Date().toISOString(), headless: spec.headless }
  await writeFile(join(spec.profileDir, STATE_FILE), JSON.stringify(state), 'utf8')
  return runningChrome(pid, endpoint, spec.profileDir)
}

async function ensureFirstPage(endpoint: DevToolsEndpoint, logger: LaunchLogger): Promise<void> {
  const targets = await listTargets(endpoint.port)
  if (targets.some((target) => target.type === 'page')) return
  try {
    await cdpCommand(endpoint.browserWs, 'Target.createTarget', { url: 'about:blank', background: true })
  } catch (error) {
    logger.warn(`dsh-chrome: could not create the first page: ${String(error)}`)
  }
}

/**
 * Remove the state file for a profile when its browser is gone.
 * @param profileDir - instance profile directory.
 */
export async function forgetChrome(profileDir: string): Promise<void> {
  await rm(join(profileDir, STATE_FILE), { force: true })
}

/** Child process handle retained for tests. */
export type { ChildProcess }
