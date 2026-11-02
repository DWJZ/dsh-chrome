/**
 * Recovery check: when the chrome-devtools-mcp child dies, the next call reports
 * `browser_down` (page ids changed) and later calls work against a restarted
 * server. Run with `node --import tsx/esm test/recovery.mjs`.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateChrome } from '../src/chrome/locate.ts'
import { ChromeError } from '../src/errors.ts'
import { ChromeManager } from '../src/manager.ts'

const logger = { info: () => {}, warn: (message) => console.warn(`[warn] ${message}`) }
const root = mkdtempSync(join(tmpdir(), 'dsh-chrome-recovery-'))
const manager = new ChromeManager({
  profileRoot: root,
  defaultProfile: 'default',
  screenshotDir: join(root, 'shots'),
  resolveExecutable: () => locateChrome('auto'),
  chromeArgs: [],
  toolCallTimeoutMs: 30000,
  leaseTtlMs: 60000,
  ephemeralCloseOn: 'turn',
  isAgentAlive: () => true,
  logger,
})

try {
  const instance = await manager.open('recover', { headless: true, ephemeral: true, ownerAgentId: 'agent-r' })
  assert.ok((await instance.pages()).length >= 1, 'browser starts with a page')
  const port = instance.port
  assert.ok(port !== undefined)

  // Node sets the server's process title, so argv is unreadable; match the
  // child of this test process instead.
  const pids = execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes('chrome-devtools-mcp'))
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => Number(fields[1]) === process.pid)
    .map((fields) => Number(fields[0]))
    .filter((value) => Number.isFinite(value) && value > 0)
  assert.ok(pids.length > 0, 'the MCP server process is running')
  for (const pid of pids) process.kill(pid, 'SIGKILL')

  await assert.rejects(instance.pages(), (error) => error instanceof ChromeError && error.code === 'browser_down')

  const afterRestart = await instance.pages()
  assert.ok(afterRestart.length >= 1, 'later calls use the restarted server')
  console.log('RECOVERY OK')
} finally {
  await manager.dispose().catch(() => {})
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* a Chrome helper may still hold the directory */ }
}
