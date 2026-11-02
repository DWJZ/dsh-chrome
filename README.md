---
description: "Dedicated Chrome instances for DeepSeek Harness with tab-level leases, on-demand instances, and no focus stealing."
kind: "plugin-reference"
---

# dsh-chrome

English | [中文](README.zh.md)

## Summary

`dsh-chrome` gives a Harness agent real browsers it can drive. Every instance is a Chrome process this plugin starts itself with its own profile directory, so nothing touches the browser you use day to day. Tools are served through [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp), one server per instance.

Instances are named by the agent. `chrome_browser_open` starts a headed browser by default so a person can sign in, and its profile survives restarts; `headless: true` starts a windowless one instead. A duplicate name is refused so the caller picks another.

Tabs are leased per agent. Several sessions may drive the same browser at once, but one tab belongs to one session until it releases it, closes it, or its session ends. A tool call that times out fails that call only; it never takes the tab away.

## Install

```sh
pnpm dsh plugin --profile web add link:/path/to/dsh-chrome
```

Then add the row to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-chrome
      name: dsh-chrome
```

## Configure

| Field | Default | Meaning |
|---|---|---|
| `profileRoot` | `<DSH home>/chrome` | One directory per instance; logins stored here survive restarts |
| `executablePath` | `auto` | `auto` tries `CHROME_PATH`, then installed browsers, then the usual locations |
| `toolCallTimeoutMs` | `120000` | Bound on one MCP call; it never releases a tab lease |
| `leaseTtlMs` | `1800000` | Fallback lease expiry, used only when the owning session cannot be resolved |
| `ephemeralCloseOn` | `turn` | When a headless instance closes: `turn`, `session`, or `manual` |
| `chromeArgs` | `[]` | Extra Chrome command-line arguments |
| `screenshotDir` | `<profileRoot>/screenshots` | Where screenshots land, and the only directory the MCP server may write |

## Tools

| Tool | Purpose |
|---|---|
| `chrome_browser_list` | Instances, ports, tab counts, and lease owners |
| `chrome_browser_open` | Start an instance; `name` is agent-chosen, duplicates fail |
| `chrome_browser_close` | Stop an instance and release its leases |
| `chrome_list_tabs` | Tabs with ids, titles, URLs, and owners |
| `chrome_search_tabs` | Filter tabs by title, URL, or both |
| `chrome_open_tab` | Open a background tab and claim it |
| `chrome_close_tab` | Close a tab and release it |
| `chrome_release_tab` | Release the lease without closing |
| `chrome_inspect` | Accessibility snapshot, HTML, or visible text |
| `chrome_screenshot` | Capture to a file and return its path |
| `chrome_click` | Click an element by the uid from `chrome_inspect` |
| `chrome_type_text` | Type into the focused element |
| `chrome_navigate` | Go to a URL, back, forward, or reload |
| `chrome_evaluate` | Run a function in the page; escape hatch |

## Behavior

- Launch uses `--no-startup-window` and creates the first page through CDP with `background: true`, so the browser never takes focus.
- Headless instances close when their turn ends by default, and their profile directory is deleted with them.
- Plugin load reaps headless profiles a previous host left behind; headed profiles are kept for their logins.
- If the MCP server dies, the next call reports `browser_down` because page ids changed, and later calls reconnect.
- Each instance runs one `chrome-devtools-mcp` process, mounted with `--experimentalStructuredContent` and `--workspace=<screenshotDir>`.

## Known limitations

- Page ids are local to one MCP process; a restart invalidates them together with every lease.
- Two Harness hosts sharing one profile directory do not share leases.
- The browser is driven through MCP, so upstream tools not wrapped here stay unavailable.
- A headed instance keeps running until `chrome_browser_close`, because its logins are the point.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:browser
```

`pnpm run test:browser` starts real headless Chrome; `pnpm run test:focus` is the macOS check that a headed launch leaves the front application unchanged.
