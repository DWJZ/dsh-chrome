/**
 * One chrome-devtools-mcp server process per browser instance, driven over
 * stdio. Calls always name their page, so no per-client "selected page" state
 * is involved and several agents may use the same browser concurrently.
 * @module dsh-chrome/mcp/engine
 */

import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { ChromeError } from '../errors.ts'

/** One page as chrome-devtools-mcp reports it. */
export interface McpPage {
  /** Process-local page id used by every page-scoped tool. */
  pageId: number
  /** Page title, possibly empty. */
  title: string
  /** Current URL. */
  url: string
}

/** Model-facing payload of one tool call. */
export interface McpResult {
  /** Text content joined from the MCP result. */
  text: string
  /** Structured content when the server supplied it. */
  structured: unknown
}

/** Call options for one MCP request. */
export interface McpCallOptions {
  /** Caller cancellation; aborting sends the protocol's cancellation notice. */
  signal?: AbortSignal
  /** Bound on this call only. */
  timeoutMs: number
}

const require = createRequire(import.meta.url)

/**
 * Locate the pinned `chrome-devtools-mcp` entry installed beside this plugin.
 * @returns absolute path of the server's Node entry point.
 */
function resolveServerEntry(): string {
  return require.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js')
}

/** Child environment for the server: the plugin's own plus inherited basics. */
function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** A connected chrome-devtools-mcp server for one browser instance. */
export class McpEngine {
  private constructor(private readonly client: Client) {}

  /**
   * Start and connect the server for one DevTools port.
   * @param options - the browser port and the plugin's call bound.
   * @returns a connected engine.
   * @throws {ChromeError} `browser_down` when the server cannot start.
   */
  static async start(options: { port: number; timeoutMs: number; workspaceDirs: readonly string[] }): Promise<McpEngine> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolveServerEntry(),
        '--no-usage-statistics',
        '--experimentalStructuredContent',
        ...options.workspaceDirs.map((dir) => `--workspace=${dir}`),
        '--browser-url',
        `http://127.0.0.1:${options.port}`,
      ],
      env: childEnvironment(),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'dsh-chrome', version: '0.1.0' }, { capabilities: {} })
    try {
      await client.connect(transport)
      await client.listTools()
    } catch (error) {
      await client.close().catch(() => {})
      throw new ChromeError(
        'browser_down',
        `chrome-devtools-mcp did not start for port ${options.port}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return new McpEngine(client)
  }

  /**
   * List the pages of this browser.
   * @param timeoutMs - bound on the request.
   * @returns pages in the order the server reports them.
   */
  async listPages(timeoutMs: number): Promise<McpPage[]> {
    const result = await this.call('list_pages', {}, { timeoutMs })
    const structured = (result.structured as { pages?: unknown } | undefined)?.pages
    if (Array.isArray(structured)) {
      const parsed: McpPage[] = []
      for (const entry of structured) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as { id?: unknown; title?: unknown; url?: unknown }
        if (typeof record.id !== 'number') continue
        parsed.push({
          pageId: record.id,
          title: typeof record.title === 'string' ? record.title : '',
          url: typeof record.url === 'string' ? record.url : '',
        })
      }
      return parsed
    }
    return parsePagesText(result.text)
  }

  /**
   * Invoke one chrome-devtools-mcp tool.
   * @param name - upstream tool name.
   * @param args - upstream arguments, including `pageId` for page-scoped tools.
   * @param options - cancellation and this call's time bound.
   * @returns the model-facing text and any structured content.
   * @throws {ChromeError} `timeout` when the bound elapses, otherwise the upstream failure.
   */
  async call(name: string, args: Record<string, unknown>, options: McpCallOptions): Promise<McpResult> {
    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        { signal: options.signal, timeout: options.timeoutMs },
      ) as { content?: unknown; structuredContent?: unknown; isError?: boolean }
      const text = textOf(result.content)
      if (result.isError === true) throw new ChromeError('invalid_uid', text || `${name} failed`)
      return { text, structured: result.structuredContent }
    } catch (error) {
      if (error instanceof ChromeError) throw error
      if (options.signal?.aborted === true) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/timed? out|timeout/i.test(message)) {
        throw new ChromeError('timeout', `${name} did not finish within ${options.timeoutMs}ms; the tab state is unknown, inspect before continuing`)
      }
      throw error
    }
  }

  /** Disconnect and stop the server process. */
  async close(): Promise<void> {
    await this.client.close().catch(() => {})
  }
}

/**
 * Parse the plain `list_pages` text when the server does not emit structured
 * content. Lines look like `2: Title (https://example.com/) [selected]`.
 * @param text - the tool's text content.
 * @returns the pages named on those lines.
 */
function parsePagesText(text: string): McpPage[] {
  const pages: McpPage[] = []
  for (const raw of text.split('\n')) {
    const match = /^(\d+):\s?(.*)$/.exec(raw.trim())
    if (match === null) continue
    const pageId = Number(match[1])
    let rest = (match[2] ?? '').trim()
    if (rest.endsWith('[selected]')) rest = rest.slice(0, -'[selected]'.length).trim()
    const urlMatch = /\s\(([^()]*)\)$/.exec(rest)
    if (urlMatch === null) {
      pages.push({ pageId, title: '', url: rest })
      continue
    }
    pages.push({
      pageId,
      title: rest.slice(0, urlMatch.index).trim(),
      url: urlMatch[1] ?? '',
    })
  }
  return pages
}
