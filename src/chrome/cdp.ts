/**
 * Minimal DevTools transport helpers: the HTTP endpoint a launched Chrome
 * writes, and a one-shot command over its browser WebSocket.
 * @module dsh-chrome/chrome/cdp
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Address of a running browser's DevTools endpoint. */
export interface DevToolsEndpoint {
  /** Port the browser listens on. */
  port: number
  /** Browser-level WebSocket URL, unique per browser launch. */
  browserWs: string
}

/** Where Chrome publishes the port it chose. */
export function devToolsActivePortFile(profileDir: string): string {
  return join(profileDir, 'DevToolsActivePort')
}

/**
 * Read the port and browser WebSocket path Chrome wrote for this profile.
 * @param profileDir - the launched browser's `--user-data-dir`.
 * @returns the endpoint, or undefined while the file is missing or stale.
 */
export async function readDevToolsActivePort(profileDir: string): Promise<DevToolsEndpoint | undefined> {
  let text: string
  try {
    text = await readFile(devToolsActivePortFile(profileDir), 'utf8')
  } catch {
    return undefined
  }
  const [portLine, pathLine] = text.split('\n')
  const port = Number(portLine?.trim())
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  const browserPath = pathLine?.trim()
  if (browserPath === undefined || !browserPath.startsWith('/devtools/browser/')) return undefined
  return { port, browserWs: `ws://127.0.0.1:${port}${browserPath}` }
}

/**
 * Ask a DevTools port whether a browser answers.
 * @param port - candidate port.
 * @param timeoutMs - bound on the HTTP request.
 * @returns the endpoint, or undefined when nothing answers.
 */
export async function probeDevTools(port: number, timeoutMs = 2000): Promise<DevToolsEndpoint | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown }
    const ws = typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : undefined
    if (ws === undefined) return undefined
    return { port, browserWs: ws }
  } catch {
    return undefined
  }
}

/**
 * List the page targets of one DevTools endpoint.
 * @param port - endpoint port.
 * @returns target ids and URLs; an empty array when nothing answers.
 */
export async function listTargets(port: number): Promise<{ id: string; url: string; type: string }[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return []
    const body = (await response.json()) as { id?: unknown; url?: unknown; type?: unknown }[]
    return body
      .filter((entry) => typeof entry.id === 'string' && typeof entry.url === 'string' && typeof entry.type === 'string')
      .map((entry) => ({ id: entry.id as string, url: entry.url as string, type: entry.type as string }))
  } catch {
    return []
  }
}

/**
 * Send one command over a browser-level WebSocket and return its result.
 * @param browserWs - the browser WebSocket URL.
 * @param method - CDP method name.
 * @param params - method parameters.
 * @param timeoutMs - bound on the whole exchange.
 * @returns the method result.
 */
export function cdpCommand<T>(
  browserWs: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(browserWs)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`${method} timed out`))
    }, timeoutMs)
    const settle = (error: Error | undefined, value?: T): void => {
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Closing a socket that already failed is not an error worth reporting.
      }
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    socket.onopen = () => {
      socket.send(JSON.stringify({ id: 1, method, params }))
    }
    socket.onmessage = (event: MessageEvent) => {
      let message: { id?: number; result?: T; error?: { message?: string } }
      try {
        message = JSON.parse(String(event.data)) as typeof message
      } catch {
        return
      }
      if (message.id !== 1) return
      if (message.error !== undefined) settle(new Error(message.error.message ?? `${method} failed`))
      else settle(undefined, message.result)
    }
    socket.onerror = () => settle(new Error(`${method} failed: browser WebSocket error`))
  })
}

/**
 * Wait until a predicate yields a value or the deadline passes.
 * @param probe - repeated probe; returning undefined means "not yet".
 * @param timeoutMs - overall bound.
 * @param intervalMs - delay between attempts.
 * @returns the first defined probe value.
 */
export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
