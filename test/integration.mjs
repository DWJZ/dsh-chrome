/**
 * Live integration test over the plugin's own classes: shared and throwaway
 * profiles, name and profile conflicts, a dead instance replaced on reopen,
 * tab leases across agents, the page tools, and orphan reaping.
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
const sharedDir = join(root, 'profiles', 'default')

function makeManager(isAlive = () => true) {
  return new ChromeManager({
    profileRoot: root,
    defaultProfile: 'default',
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const html = 'data:text/html,<html><body><input id=i><button id=b onclick="document.title=\'clicked\'">Press</button></body></html>'
const manager = makeManager()
try {
  // --- instances share one profile by default ------------------------------
  const one = await manager.open('one', { headless: true, ownerAgentId: 'agent-a' })
  assert.equal(one.profile, 'default')
  assert.equal(one.profileDir, sharedDir)
  const two = await manager.open('two', { headless: true, ephemeral: true, ownerAgentId: 'agent-b' })
  assert.equal(two.profile, null)
  assert.equal(two.profileDir, join(root, 'ephemeral', 'two'))

  await assert.rejects(manager.open('one', { headless: true }), (error) => error.code === 'instance_exists')
  // Chrome allows one process per profile directory.
  await assert.rejects(manager.open('three', { headless: true }), (error) => error.code === 'profile_busy')
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

  // --- a throwaway profile dies with its instance, a shared one stays ------
  const twoDir = join(root, 'ephemeral', 'two')
  assert.ok(existsSync(twoDir), 'throwaway profile exists while open')
  const closed = await manager.closeOwnedBy('agent-b', ['turn'])
  assert.deepEqual(closed, ['two'])
  assert.ok(!existsSync(twoDir), 'throwaway profile removed on close')

  assert.equal(await manager.close('one'), true)
  assert.ok(existsSync(sharedDir), 'shared profile survives the instance')
  assert.equal((await manager.list()).length, 0)

  // --- another instance finds the same profile and its logins --------------
  const three = await manager.open('three', { headless: true })
  assert.equal(three.profileDir, sharedDir)
  assert.equal((await three.pages()).length >= 1, true)

  // --- a browser that died is replaced when its name is reused -------------
  const state = await readInstanceState(sharedDir)
  assert.ok(state !== undefined, 'running browser left a state file')
  process.kill(state.pid, 'SIGKILL')
  for (let attempt = 0; attempt < 50 && isAlive(state.pid); attempt += 1) await sleep(100)
  assert.equal(manager.require('three').name, 'three')
  const revived = await manager.open('three', { headless: true })
  assert.equal(revived.profileDir, sharedDir, 'the recovered instance keeps the profile')
  assert.ok((await revived.pages()).length >= 1, 'the recovered instance has a page')
  await manager.close('three')

  // --- orphan reaping: a new manager cleans leftover throwaway browsers ----
  const orphan = await manager.open('ghost', { headless: true, ephemeral: true })
  await orphan.pages()
  const ghostDir = join(root, 'ephemeral', 'ghost')
  const ghostState = await readInstanceState(ghostDir)
  assert.ok(ghostState !== undefined, 'orphan wrote its state file')
  assert.ok(isAlive(ghostState.pid), 'orphan browser is running')

  const nextHost = makeManager()
  const reaped = await nextHost.reapOrphans()
  assert.deepEqual(reaped, ['ghost'])
  assert.ok(!isAlive(ghostState.pid), 'orphan browser stopped')
  assert.ok(!existsSync(ghostDir), 'orphan profile removed')

  // A profile left behind without its state file is still recognised by its marker.
  const markerOnly = join(root, 'ephemeral', 'marker-only')
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
