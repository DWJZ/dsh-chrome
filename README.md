---
description: "Dedicated Chrome instances for DeepSeek Harness with tab-level leases, on-demand instances, and no focus stealing."
kind: "plugin-reference"
---

# dsh-chrome

English | [中文](README.zh.md)

## Summary

`dsh-chrome` gives a Harness agent real browsers it can drive. Every instance is a Chrome process this plugin starts itself with its own profile directory, so nothing touches the browser you use day to day. Tools are served through [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp), one server per instance.

Instances start headed by default so a person can sign in, and share one profile: every instance uses the default profile unless it asks for another with `profile` or for none with `ephemeral: true`. Chrome allows one process per profile directory, so a profile backs one running browser at a time, and logins carry across instances opened one after another.

Opening without a name targets `default`, so every session that just calls `chrome_browser_open` reaches the same browser and splits it into tabs. A headed name that is already open returns that instance with `reused: true` instead of failing; only a profile the caller named explicitly and that differs from the open one is refused, with the name of the holder.

A headless browser is isolated to its instance: `name` is required, the profile is throwaway unless `profile` names one, and a name that is already open is refused so two callers cannot silently share one. Headed browsers keep the shared profile and the reuse behavior.

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
| `chrome_browser_open` | Open the shared GUI browser (`default`, reused when open) or a named headless instance (name required, exclusive); `profile` picks a shared profile, `ephemeral` a throwaway one |
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
- Chrome starts with `--disable-blink-features=AutomationControlled`: an open DevTools port otherwise makes pages report `navigator.webdriver`, and sign-in providers reject such a browser.
- Headless instances close when their turn ends by default; a throwaway profile is deleted with them.
- An instance another session is still using stays open past its owner's turn: a tab held elsewhere outranks the close policy, and the instance is collected once nobody holds a tab.
- Plugin load reaps headless profiles a previous host left behind; headed profiles are kept for their logins.
- If the MCP server dies, the next call reports `browser_down` because page ids changed, and later calls reconnect.
- Each instance runs one `chrome-devtools-mcp` process, mounted with `--experimentalStructuredContent` and `--workspace=<screenshotDir>`.

## Known limitations

- Page ids are local to one MCP process; a restart invalidates them together with every lease.
- Two Harness hosts sharing one profile directory do not share leases.
- The browser is driven through MCP, so upstream tools not wrapped here stay unavailable.
- A headed instance keeps running until `chrome_browser_close`, because its logins are the point.
- A shared profile belongs to one running instance; the second caller is told which instance holds it.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:browser
```

`pnpm run test:browser` starts real headless Chrome; `pnpm run test:focus` is the macOS check that a headed launch leaves the front application unchanged.
