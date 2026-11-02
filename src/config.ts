/**
 * Plugin configuration. Every deployment-varying choice is a validated field;
 * nothing here is tuned by a constant in the implementation.
 * @module dsh-chrome/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** When an on-demand instance releases its Chrome process. */
export type CloseOn = 'turn' | 'session' | 'manual'

/** Raw plugin configuration as written in `cordis.patch.yml`. */
export interface Config {
  /** Root holding one directory per instance; defaults to `<DSH home>/chrome`. */
  profileRoot?: string
  /** Chrome executable, or `auto` to discover an installed browser. */
  executablePath?: string
  /** Bound on one MCP call. Expiry fails that call; it never releases a tab lease. */
  toolCallTimeoutMs?: number
  /** Fallback lease expiry, consulted only when the owning agent cannot be resolved. */
  leaseTtlMs?: number
  /** Default close policy for headless instances created on demand. */
  ephemeralCloseOn?: CloseOn
  /** Extra Chrome command-line arguments appended after the plugin's own. */
  chromeArgs?: string[]
  /** Profile every instance shares unless it asks for another or none. */
  defaultProfile?: string
  /** Screenshot directory; defaults to `<profileRoot>/screenshots`. */
  screenshotDir?: string
}

/** Configuration after defaults are applied. */
export interface ResolvedConfig {
  profileRoot: string
  executablePath: string
  toolCallTimeoutMs: number
  leaseTtlMs: number
  ephemeralCloseOn: CloseOn
  chromeArgs: string[]
  defaultProfile: string
  screenshotDir: string
}

const CLOSE_POLICIES: readonly CloseOn[] = ['turn', 'session', 'manual']

/**
 * Resolve the harness home: `DSH_HOME` when set, otherwise `~/.dsh`.
 * @param env - environment to read.
 * @returns absolute home directory.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  if (configured !== undefined && configured !== '') return expandHome(configured)
  return join(homedir(), '.dsh')
}

/**
 * Expand a leading `~` to the current user's home directory.
 * @param path - configured path, possibly starting with `~`.
 * @returns the absolute path.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function positive(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`dsh-chrome: ${field} must be a positive number`)
  }
  return value
}

/**
 * Apply defaults and validate the operator's configuration.
 * @param raw - configuration as written in the profile patch.
 * @param home - harness home directory, used for the default profile root.
 * @returns the resolved configuration.
 * @throws when a field has the wrong type or an unsupported value.
 */
export function resolveConfig(raw: Config = {}, home: string = dshHome()): ResolvedConfig {
  const profileRoot = raw.profileRoot?.trim()
  const screenshotDir = raw.screenshotDir?.trim()
  const executablePath = raw.executablePath?.trim()
  const closeOn = raw.ephemeralCloseOn ?? 'turn'
  const defaultProfile = raw.defaultProfile?.trim() ?? ''
  if (!CLOSE_POLICIES.includes(closeOn)) {
    throw new Error(`dsh-chrome: ephemeralCloseOn must be one of ${CLOSE_POLICIES.join(', ')}`)
  }
  const chromeArgs = raw.chromeArgs ?? []
  if (!Array.isArray(chromeArgs) || chromeArgs.some((arg) => typeof arg !== 'string')) {
    throw new Error('dsh-chrome: chromeArgs must be an array of strings')
  }
  const root = profileRoot === undefined || profileRoot === '' ? join(home, 'chrome') : expandHome(profileRoot)
  return {
    profileRoot: root,
    executablePath: executablePath === undefined || executablePath === '' ? 'auto' : executablePath,
    toolCallTimeoutMs: positive(raw.toolCallTimeoutMs, 120_000, 'toolCallTimeoutMs'),
    leaseTtlMs: positive(raw.leaseTtlMs, 1_800_000, 'leaseTtlMs'),
    ephemeralCloseOn: closeOn,
    chromeArgs,
    defaultProfile: defaultProfile === '' ? 'default' : defaultProfile,
    screenshotDir: screenshotDir === undefined || screenshotDir === '' ? join(root, 'screenshots') : expandHome(screenshotDir),
  }
}
