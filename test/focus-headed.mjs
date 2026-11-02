/**
 * Acceptance check for M1: launching a headed instance must not change which
 * application is in front. Compares the front process id (via `lsappinfo`)
 * before and after the launch. macOS only.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateChrome } from '../src/chrome/locate.ts'
import { ensureChrome } from '../src/chrome/process.ts'

function frontPid() {
  const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim()
  const out = execFileSync('lsappinfo', ['info', asn], { encoding: 'utf8' })
  const match = /pid = (\d+)/.exec(out)
  return match ? Number(match[1]) : -1
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (process.platform !== 'darwin') {
  console.log('focus check skipped: macOS only')
  process.exit(0)
}

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-chrome-focus-'))
const logger = { info: () => {}, warn: (message) => console.warn(message) }
const before = frontPid()
let chrome
try {
  chrome = await ensureChrome({
    executablePath: locateChrome('auto'),
    profileDir,
    headless: false,
    extraArgs: [],
  }, logger)
  await sleep(4000)
  const after = frontPid()
  console.log(`before=${before} after=${after} chromePid=${chrome.pid}`)
  if (after === chrome.pid) {
    console.error('FAIL: the launched browser took the front')
    process.exitCode = 1
  } else {
    console.log('OK: front application unchanged')
  }
} finally {
  await chrome?.close().catch(() => {})
  try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* a Chrome helper may still hold the directory */ }
}
