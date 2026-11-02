/**
 * Live smoke test: launch a real headless Chrome, drive it through the MCP
 * engine, and stop it. Run with `DSH_CHROME_E2E=1 node --import tsx/esm test/smoke.mjs`.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateChrome } from '../src/chrome/locate.ts'
import { ensureChrome } from '../src/chrome/process.ts'
import { McpEngine } from '../src/mcp/engine.ts'

const logger = {
  info: (message) => console.log(`[info] ${message}`),
  warn: (message) => console.warn(`[warn] ${message}`),
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-chrome-smoke-'))
const screenshotPath = join(profileDir, 'shot.png')
let chrome
let engine
try {
  chrome = await ensureChrome({
    executablePath: locateChrome('auto'),
    profileDir,
    headless: true,
    extraArgs: [],
  }, logger)
  console.log(`chrome on port ${chrome.endpoint.port}, pid ${chrome.pid}`)

  engine = await McpEngine.start({ port: chrome.endpoint.port, timeoutMs: 30000, workspaceDirs: [profileDir] })
  const pages = await engine.listPages(30000)
  assert(pages.length >= 1, 'launch creates one page')
  console.log('pages:', pages.map((page) => `${page.pageId}:${page.url}`).join(', '))

  const html = 'data:text/html,<html><body><h1 id=t>hello dsh-chrome</h1></body></html>'
  await engine.call('new_page', { url: html, background: true }, { timeoutMs: 30000 })
  const afterOpen = await engine.listPages(30000)
  assert(afterOpen.length === pages.length + 1, `open_tab adds one page (${afterOpen.length})`)
  const target = afterOpen.find((page) => page.url.startsWith('data:text/html'))
  assert(target !== undefined, 'new page is listed')

  const snapshot = await engine.call('take_snapshot', { pageId: target.pageId }, { timeoutMs: 30000 })
  assert(snapshot.text.includes('hello dsh-chrome'), 'snapshot contains the heading text')
  console.log('snapshot ok, bytes:', snapshot.text.length)

  await engine.call('take_screenshot', {
    pageId: target.pageId,
    format: 'png',
    fullPage: false,
    filePath: screenshotPath,
  }, { timeoutMs: 30000 })
  assert(statSync(screenshotPath).size > 1000, 'screenshot file written')
  console.log('screenshot ok:', screenshotPath)

  await engine.call('close_page', { pageId: target.pageId }, { timeoutMs: 30000 })
  const afterClose = await engine.listPages(30000)
  assert(afterClose.length === pages.length, 'close_page removes it')
  console.log('SMOKE OK')
} finally {
  await engine?.close().catch(() => {})
  await chrome?.close().catch(() => {})
  rmSync(profileDir, { recursive: true, force: true })
}
