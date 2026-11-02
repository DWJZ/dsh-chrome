/**
 * Live integration test over the plugin's own classes: multi-instance naming,
 * tab leases across agents, the page tools, headless cleanup, and orphan reaping.
 * Run with `node --import tsx/esm test/integration.mjs`.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateChrome } from '../src/chrome/locate.ts'
import { readInstanceState } from '../src/chrome/process.ts'
import { ChromeManager } from '../src/manager.ts'

const logger = { info: () => {}, warn: (message) => console.warn(`[warn] ${message}`) }
const root = mkdtempSync(join(tmpdir(), 'dsh-chrome-it-'))

function makeManager(isAlive = () => true) {
  return new ChromeManager({
    profileRoot: join(root, 'profiles'),
    screenshotDir: join(root, 'shots'),
    resolveExecutable: () => locateChrome('auto'),
    chromeArgs: [],
    toolCallTimeoutMs: 30000,
    leaseTtlMs: 60000,
    ephemeralCloseOn: 'turn',
    isAgentAlive: isAlive,
    logger,
  })
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const html = 'data:text/html,<html><body><input id=i><button id=b onclick="document.title=\'clicked\'">Press</button></body></html>'
const manager = makeManager()
try {
  // --- two instances, names are unique -------------------------------------
  const one = await manager.open('one', true, 'agent-a')
  const two = await manager.open('two', true, 'agent-b')
  await assert.rejects(manager.open('one', true, 'agent-c'), (error) => error.code === 'instance_exists')
  assert.equal((await manager.list()).length, 2)

  // --- leases: one owner per tab -------------------------------------------
  const tab = await openTab(one, html)
  one.leases.claim(tab.pageId, 'agent-a')
  assert.throws(() => one.leases.claim(tab.pageId, 'agent-b'), (error) => error.code === 'tab_busy')
  manager.releaseAgent('agent-a')
  one.leases.claim(tab.pageId, 'agent-b')

  // --- page tools ----------------------------------------------------------
  await one.call('take_snapshot', { pageId: tab.pageId })
  const snapshot = await one.call('evaluate_script', { pageId: tab.pageId, function: '() => document.body.innerHTML' })
  assert.match(snapshot.text, /Press/, 'html read sees the button')

  // Chrome advertises automation whenever a DevTools port is open unless the
  // plugin disables it; sign-in providers reject such a browser.
  const webdriver = await one.call('evaluate_script', { pageId: tab.pageId, function: '() => navigator.webdriver' })
  assert.match(webdriver.text, /false/, 'pages do not advertise automation')

  const buttonUid = /uid=(\S+) button/.exec((await one.call('take_snapshot', { pageId: tab.pageId })).text)
  assert.ok(buttonUid, 'snapshot exposes the button uid')
  await one.call('click', { pageId: tab.pageId, uid: buttonUid[1] })
  const title = await one.call('evaluate_script', { pageId: tab.pageId, function: '() => document.title' })
  assert.match(title.text, /clicked/, 'click ran the handler')

  await one.call('evaluate_script', { pageId: tab.pageId, function: '() => document.getElementById("i").focus()' })
  await one.call('type_text', { pageId: tab.pageId, text: 'hello' })
  const value = await one.call('evaluate_script', { pageId: tab.pageId, function: '() => document.getElementById("i").value' })
  assert.match(value.text, /hello/, 'typed text reached the input')

  await one.call('navigate_page', { pageId: tab.pageId, type: 'url', url: 'data:text/html,<title>nav</title><p>done' })
  const afterNav = await one.call('evaluate_script', { pageId: tab.pageId, function: '() => document.title' })
  assert.match(afterNav.text, /nav/, 'navigate changed the document')

  // --- headless instances close with their owner and drop the profile ------
  const twoDir = join(root, 'profiles', 'two')
  assert.ok(existsSync(twoDir), 'headless profile exists while open')
  const closed = await manager.closeOwnedBy('agent-b', ['turn'])
  assert.deepEqual(closed, ['two'])
  assert.ok(!existsSync(twoDir), 'headless profile removed on close')

  assert.equal(await manager.close('one'), true)
  assert.ok(!existsSync(join(root, 'profiles', 'one')), 'explicit close removes the headless profile')
  assert.equal((await manager.list()).length, 0)

  // --- orphan reaping: a new manager cleans a leftover headless browser ----
  const orphan = await manager.open('ghost', true, 'agent-x')
  await orphan.pages()
  const ghostDir = join(root, 'profiles', 'ghost')
  const state = await readInstanceState(ghostDir)
  assert.ok(state !== undefined, 'orphan wrote its state file')
  assert.ok(isAlive(state.pid), 'orphan browser is running')

  const nextHost = makeManager()
  const reaped = await nextHost.reapOrphans()
  assert.deepEqual(reaped, ['ghost'])
  assert.ok(!isAlive(state.pid), 'orphan browser stopped')
  assert.ok(!existsSync(ghostDir), 'orphan profile removed')
  // A profile left behind without its state file is still recognised by its marker.
  const markerOnly = join(root, 'profiles', 'marker-only')
  mkdirSync(markerOnly, { recursive: true })
  writeFileSync(join(markerOnly, '.dsh-chrome-profile.json'), JSON.stringify({ headless: true }))
  const reapedAgain = await nextHost.reapOrphans()
  assert.deepEqual(reapedAgain, ['marker-only'])
  assert.ok(!existsSync(markerOnly), 'marker-only profile removed')

  await nextHost.dispose()

  console.log('INTEGRATION OK')
} finally {
  await manager.dispose().catch(() => {})
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* a Chrome helper may still hold the directory */ }
}

async function openTab(instance, url) {
  const before = new Set((await instance.pages()).map((page) => page.pageId))
  await instance.call('new_page', { url, background: true })
  const after = await instance.pages()
  const created = after.find((page) => !before.has(page.pageId))
  assert.ok(created !== undefined, 'new_page created a tab')
  return created
}
