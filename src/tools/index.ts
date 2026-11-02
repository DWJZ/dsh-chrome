/**
 * Model-facing tools. Every page-scoped tool names its tab and claims a lease
 * for the calling agent before touching the browser.
 * @module dsh-chrome/tools
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '../tool-contract.ts'
import type { ToolDefinition } from '../tool-contract.ts'
import { ChromeError, describeError } from '../errors.ts'
import { DEFAULT_BROWSER } from '../manager.ts'
import type { ChromeManager } from '../manager.ts'
import type { BrowserInstance } from '../instance.ts'

/** Context data every tool body receives. */
interface ToolDeps {
  manager: ChromeManager
  screenshotDir: string
}

const BROWSER_PARAM = {
  type: 'string',
  description: 'Browser instance name. Defaults to "default".',
} as const

const BROWSER_REQUIRED = {
  type: 'string',
  required: true,
  description: 'Browser instance name.',
} as const

const TAB_PARAM = {
  type: 'number',
  required: true,
  description: 'Tab id from chrome_list_tabs.',
} as const

/** One tab as the tools report it. */
type TabView = {
  tabId: number
  title: string
  url: string
  owner: string | null
}

function ownerOf(exec: { agent?: { id: string } }): string {
  return exec.agent?.id ?? 'anonymous'
}

/** Claim the tab for this caller, then run the work after that tab's queue. */
async function withTab<T>(
  instance: BrowserInstance,
  exec: { agent?: { id: string } },
  tabId: number,
  work: () => Promise<T>,
): Promise<T> {
  const owner = ownerOf(exec)
  instance.leases.claim(tabId, owner)
  return instance.serial(tabId, async () => {
    instance.leases.claim(tabId, owner)
    return work()
  })
}

/** Translate an upstream "no page" failure into a lease-aware error. */
function translate(error: unknown, tabId: number): never {
  const message = error instanceof Error ? error.message : String(error)
  if (/No page found|page.*closed|Target closed/i.test(message)) {
    throw new ChromeError('tab_gone', `tab ${tabId} is gone; call chrome_list_tabs for the current tabs`)
  }
  throw error
}

function renderJson(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const JSON_OUTPUT = {
  schema: {},
  render: (_args: unknown, value: unknown) => renderJson(value),
}

/**
 * Register every browser tool on the plugin's context.
 * @param ctx - plugin context providing the tool registry.
 * @param deps - instance manager and screenshot location.
 */
export function registerTools(ctx: { tools: { register(definition: ToolDefinition): () => void } }, deps: ToolDeps): void {
  const { manager, screenshotDir } = deps

  ctx.tools.register(defineTool({
    name: 'chrome_browser_list',
    description: 'List the Chrome instances this plugin manages, with their tabs and lease owners.',
    parameters: {},
    output: JSON_OUTPUT,
    async execute() {
      return { browsers: await manager.list() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_browser_open',
    description: 'Open a dedicated Chrome instance. Headed by default so a person can sign in; the profile persists across restarts. Names are agent-chosen and must be unique.',
    parameters: {
      name: { type: 'string', description: `Instance name (letters, digits, - and _). Defaults to an unused name; "${DEFAULT_BROWSER}" is what tools use when no browser is given.` },
      headless: { type: 'boolean', description: 'Start without a window. Defaults to false (headed).' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const headless = args.headless ?? false
      let name = args.name?.trim()
      if (name === undefined || name === '') name = await freeName(manager)
      const instance = await manager.open(name, headless, ownerOf(exec))
      return { name: instance.name, headless: instance.headless, port: instance.port ?? null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_browser_close',
    description: 'Stop one Chrome instance and release every tab it owns.',
    parameters: {
      browser: BROWSER_REQUIRED,
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const closed = await manager.close(args.browser)
      if (!closed) throw new ChromeError('instance_gone', `browser "${args.browser}" is not open`)
      return { browser: args.browser, closed: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_list_tabs',
    description: 'List the tabs of one browser with their ids and current lease owners.',
    parameters: { browser: BROWSER_PARAM },
    output: JSON_OUTPUT,
    async execute(args) {
      const instance = manager.require(args.browser)
      return { browser: instance.name, tabs: await tabsOf(instance) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_search_tabs',
    description: 'Find tabs by filtering their title and/or URL. This does not search inside pages.',
    parameters: {
      query: { type: 'string', required: true, description: 'Case-insensitive substring.' },
      in: { type: 'string', description: '"title", "url" (default), or "both".' },
      browser: BROWSER_PARAM,
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const instance = manager.require(args.browser)
      const query = args.query.toLowerCase()
      const where = args.in ?? 'url'
      const tabs = (await instance.pages()).filter((page) => {
        const inTitle = page.title.toLowerCase().includes(query)
        const inUrl = page.url.toLowerCase().includes(query)
        if (where === 'title') return inTitle
        if (where === 'both') return inTitle || inUrl
        return inUrl
      })
      return { browser: instance.name, tabs: tabs.map((page) => tabView(instance, page.pageId, page.title, page.url)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_open_tab',
    description: 'Open a tab in the background (never steals focus) and claim it for this session.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL to open.' },
      browser: BROWSER_PARAM,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const instance = manager.require(args.browser)
      const before = new Set((await instance.pages()).map((page) => page.pageId))
      await instance.call('new_page', { url: args.url, background: true }, exec.signal)
      const after = await instance.pages()
      const created = after.find((page) => !before.has(page.pageId)) ?? after.find((page) => page.url === args.url)
      if (created === undefined) throw new ChromeError('tab_gone', 'the tab was created but is not listed; call chrome_list_tabs')
      instance.leases.claim(created.pageId, ownerOf(exec))
      return tabView(instance, created.pageId, created.title, created.url)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_close_tab',
    description: 'Close a tab and release its lease. The last remaining tab cannot be closed.',
    parameters: {
      tabId: TAB_PARAM,
      browser: BROWSER_PARAM,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const instance = manager.require(args.browser)
      return withTab(instance, exec, args.tabId, async () => {
        try {
          await instance.call('close_page', { pageId: args.tabId }, exec.signal)
        } catch (error) {
          translate(error, args.tabId)
        }
        instance.leases.release(args.tabId)
        return { tabId: args.tabId, closed: true }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_release_tab',
    description: 'Release this session\'s lease on a tab without closing it.',
    parameters: {
      tabId: TAB_PARAM,
      browser: BROWSER_PARAM,
    },
    output: JSON_OUTPUT,
    async execute(args) {
      const instance = manager.require(args.browser)
      instance.leases.release(args.tabId)
      return { tabId: args.tabId, released: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_inspect',
    description: 'Read a tab: the accessibility snapshot (a11y, default), its HTML, or its visible text.',
    parameters: {
      tabId: TAB_PARAM,
      mode: { type: 'string', description: '"a11y" (default), "html", or "text".' },
      browser: BROWSER_PARAM,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const instance = manager.require(args.browser)
      const mode = args.mode ?? 'a11y'
      return withTab(instance, exec, args.tabId, async () => {
        try {
          if (mode === 'html') {
            const result = await instance.call('evaluate_script', {
              pageId: args.tabId,
              function: '() => document.documentElement.outerHTML',
            }, exec.signal)
            return { tabId: args.tabId, mode, content: result.text }
          }
          if (mode === 'text') {
            const result = await instance.call('evaluate_script', {
              pageId: args.tabId,
              function: '() => document.body.innerText',
            }, exec.signal)
            return { tabId: args.tabId, mode, content: result.text }
          }
          const result = await instance.call('take_snapshot', { pageId: args.tabId }, exec.signal)
          return { tabId: args.tabId, mode: 'a11y', content: result.text }
        } catch (error) {
          translate(error, args.tabId)
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_screenshot',
    description: 'Capture a tab to a PNG/JPEG/WebP file and return its path.',
    parameters: {
      tabId: TAB_PARAM,
      fullPage: { type: 'boolean', description: 'Capture the whole page instead of the viewport.' },
      format: { type: 'string', description: '"png" (default), "jpeg", or "webp".' },
      browser: BROWSER_PARAM,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const instance = manager.require(args.browser)
      const format = args.format ?? 'png'
      return withTab(instance, exec, args.tabId, async () => {
        await mkdir(screenshotDir, { recursive: true })
        const path = join(screenshotDir, `${instance.name}-${args.tabId}-${Date.now()}.${format}`)
        try {
          await instance.call('take_screenshot', {
            pageId: args.tabId,
            format,
            fullPage: args.fullPage ?? false,
            filePath: path,
          }, exec.signal)
        } catch (error) {
          translate(error, args.tabId)
        }
        return { tabId: args.tabId, path }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_click',
    description: 'Click an element by the uid from chrome_inspect.',
    parameters: {
      tabId: TAB_PARAM,
      uid: { type: 'string', required: true, description: 'Element uid from chrome_inspect.' },
      dblClick: { type: 'boolean', description: 'Double-click instead of a single click.' },
      browser: BROWSER_PARAM,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const instance = manager.require(args.browser)
      return withTab(instance, exec, args.tabId, async () => {
        try {
          const result = await instance.call('click', {
            pageId: args.tabId,
            uid: args.uid,
            ...(args.dblClick === undefined ? {} : { dblClick: args.dblClick }),
          }, exec.signal)
          return { tabId: args.tabId, result: result.text }
        } catch (error) {
          translate(error, args.tabId)
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_type_text',
    description: 'Type text into the focused element of a tab, optionally pressing submit.',
    parameters: {
      tabId: TAB_PARAM,
      text: { type: 'string', required: true, description: 'Text to type.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      browser: BROWSER_PARAM,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const instance = manager.require(args.browser)
      return withTab(instance, exec, args.tabId, async () => {
        try {
          const result = await instance.call('type_text', {
            pageId: args.tabId,
            text: args.text,
            ...(args.submit === true ? { submitKey: 'Enter' } : {}),
          }, exec.signal)
          return { tabId: args.tabId, result: result.text }
        } catch (error) {
          translate(error, args.tabId)
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_navigate',
    description: 'Navigate a tab to a URL, or go back, forward, or reload.',
    parameters: {
      tabId: TAB_PARAM,
      action: { type: 'string', description: '"url" (default), "back", "forward", or "reload".' },
      url: { type: 'string', description: 'Destination URL when action is "url".' },
      browser: BROWSER_PARAM,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const instance = manager.require(args.browser)
      const action = args.action ?? 'url'
      if (action === 'url' && (args.url === undefined || args.url === '')) {
        throw new ChromeError('instance_gone', 'action "url" needs a url argument')
      }
      return withTab(instance, exec, args.tabId, async () => {
        try {
          await instance.call('navigate_page', {
            pageId: args.tabId,
            type: action,
            ...(action === 'url' ? { url: args.url } : {}),
          }, exec.signal)
          return { tabId: args.tabId, action, url: args.url ?? null }
        } catch (error) {
          translate(error, args.tabId)
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chrome_evaluate',
    description: 'Run a JavaScript function in a tab and return its result. Escape hatch; prefer the dedicated tools.',
    parameters: {
      tabId: TAB_PARAM,
      script: { type: 'string', required: true, description: 'Function source, for example "() => document.title".' },
      browser: BROWSER_PARAM,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const instance = manager.require(args.browser)
      return withTab(instance, exec, args.tabId, async () => {
        try {
          const result = await instance.call('evaluate_script', {
            pageId: args.tabId,
            function: args.script,
          }, exec.signal)
          return { tabId: args.tabId, result: result.text }
        } catch (error) {
          translate(error, args.tabId)
        }
      })
    },
  }))
}

async function tabsOf(instance: BrowserInstance): Promise<TabView[]> {
  const pages = await instance.pages()
  return pages.map((page) => tabView(instance, page.pageId, page.title, page.url))
}

function tabView(instance: BrowserInstance, pageId: number, title: string, url: string): TabView {
  return { tabId: pageId, title, url, owner: instance.leases.owner(pageId) ?? null }
}

async function freeName(manager: ChromeManager): Promise<string> {
  const taken = new Set((await manager.list()).map((summary) => summary.name))
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? DEFAULT_BROWSER : `${DEFAULT_BROWSER}-${index}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Re-exported so callers can render failures consistently. */
export { describeError }
