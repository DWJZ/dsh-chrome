/**
 * Chrome executable discovery. An explicit configuration value wins, then
 * `CHROME_PATH`, then the browsers installed on this machine.
 * @module dsh-chrome/chrome/locate
 */

import { accessSync, constants } from 'node:fs'
import { Launcher } from 'chrome-launcher'
import { ChromeError } from '../errors.ts'

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
]

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
]

function runnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function fromLauncher(): string[] {
  try {
    return Launcher.getInstallations()
  } catch {
    return []
  }
}

/**
 * Resolve the Chrome executable used by every instance this plugin starts.
 * @param configured - an absolute path, or `auto`/empty for discovery.
 * @returns an executable path that exists and is runnable.
 * @throws {ChromeError} `chrome_not_found` when nothing runnable is found.
 */
export function locateChrome(configured: string): string {
  const explicit = configured.trim()
  if (explicit !== '' && explicit !== 'auto') {
    if (!runnable(explicit)) {
      throw new ChromeError('chrome_not_found', `configured executablePath is not runnable: ${explicit}`)
    }
    return explicit
  }
  const env = process.env.CHROME_PATH?.trim()
  if (env !== undefined && env !== '' && runnable(env)) return env
  const candidates = [
    ...fromLauncher(),
    ...(process.platform === 'darwin' ? MAC_CANDIDATES : []),
    ...(process.platform === 'linux' ? LINUX_CANDIDATES : []),
  ]
  for (const candidate of candidates) {
    if (runnable(candidate)) return candidate
  }
  throw new ChromeError(
    'chrome_not_found',
    'no Google Chrome installation was found; set executablePath or CHROME_PATH to the browser binary',
  )
}
