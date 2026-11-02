/**
 * Structured failures returned to the model. Each code names a state the caller
 * can act on, so the message always says what to do next.
 * @module dsh-chrome/errors
 */

/** Error codes a tool result may carry. */
export type ChromeErrorCode =
  | 'browser_down'
  | 'instance_gone'
  | 'instance_exists'
  | 'instance_name_required'
  | 'profile_busy'
  | 'tab_busy'
  | 'tab_gone'
  | 'timeout'
  | 'invalid_uid'
  | 'chrome_not_found'

/** Plugin failure carrying a stable code and an actionable message. */
export class ChromeError extends Error {
  /**
   * @param code - stable machine-readable failure code.
   * @param message - actionable text shown to the model.
   */
  constructor(readonly code: ChromeErrorCode, message: string) {
    super(message)
    this.name = 'ChromeError'
  }
}

/**
 * Render a failure as one model-facing line that keeps the code.
 * @param error - any thrown value.
 * @returns the code-prefixed message.
 */
export function describeError(error: unknown): string {
  if (error instanceof ChromeError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}
