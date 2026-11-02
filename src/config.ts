/**
 * Plugin configuration. Every deployment-varying choice is a validated field;
 * nothing here is tuned by a constant in the implementation.
 * @module dsh-chrome/config
 */

import Schema from '@deepseek-ai/schemastery'

/** When an on-demand instance releases its Chrome process. */
export type CloseOn = 'turn' | 'session' | 'manual'

/** Raw plugin configuration as written in `cordis.patch.yml`. */
export interface Config {
  /** Root holding one directory per instance; defaults to `<DSH home>/chrome`. */
  profileRoot?: string
  /** Chrome executable, or `auto` to discover an installed browser. */
  executablePath?: string
  /** Bound on one MCP call. Expiry fails that call; it never releases a tab lease. */
  toolCallTimeoutMs?: number
  /** Fallback lease expiry, consulted only when the owning agent cannot be resolved. */
  leaseTtlMs?: number
  /** Default close policy for headless instances created on demand. */
  ephemeralCloseOn?: CloseOn
  /** Extra Chrome command-line arguments appended after the plugin's own. */
  chromeArgs?: string[]
  /** Screenshot directory; defaults to `<profileRoot>/screenshots`. */
  screenshotDir?: string
}

/** Configuration after defaults are applied. */
export type ResolvedConfig = Required<Omit<Config, 'chromeArgs' | 'screenshotDir'>> & {
  chromeArgs: string[]
  screenshotDir: string
}

/** Loader-facing schema; defaults are the documented behavior for omitted fields. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  profileRoot: Schema.string().default(''),
  executablePath: Schema.string().default('auto'),
  toolCallTimeoutMs: Schema.number().min(1).default(120000),
  leaseTtlMs: Schema.number().min(1).default(1800000),
  ephemeralCloseOn: Schema.union(['turn', 'session', 'manual']).default('turn'),
  chromeArgs: Schema.array(Schema.string()).default([]),
  screenshotDir: Schema.string().default(''),
})
