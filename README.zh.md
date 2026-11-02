---
description: "DeepSeek Harness 的专用 Chrome 实例：tab 级租约、按需实例、启动不抢焦点。"
kind: "plugin-reference"
---

# dsh-chrome

[English](README.md) | 中文

## 摘要

`dsh-chrome` 给 Harness agent 一批它能真正操控的浏览器。每个实例都是本插件自己起的 Chrome 进程，用独立的 profile 目录，所以不会碰你日常用的那个浏览器。工具经 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) 提供，一个实例一个 server。

默认开带界面的那种（方便人登录），并且共享同一个 profile：除非用 `profile` 指定另一个、或用 `ephemeral: true` 表示不用 profile，否则都落在默认 profile 上。Chrome 一个 profile 目录同时只能有一个进程，所以一个 profile 在同一时刻只支撑一个运行中的实例；登录态在前后两次开的实例之间是通的。

不带名字时开的就是 `default`，所以每个会话只要调 `chrome_browser_open` 就落到同一个浏览器上，再各自分 tab 用。带界面的同名实例已经开着时，直接把它返回（`reused: true`），不报错；只有当调用方显式点名了另一个 profile、而它和已开的那个不一致时才会被拒绝，并告诉你是谁占着。

无头实例是按实例隔离的：`name` 必填，profile 默认一次性（除非用 `profile` 点名），同名已开会被拒绝，避免两个调用方悄悄共用一个。带界面的实例保持共享 profile 与同名复用。

tab 按 agent 租借。多个会话可以同时操作同一个浏览器，但一个 tab 在同一时刻只归一个会话，直到它释放、关闭该 tab，或者会话结束。工具调用超时只让那一次调用失败，不会把 tab 收走。

## 安装

```sh
pnpm dsh plugin --profile web add link:/path/to/dsh-chrome
```

然后在 profile 的 `cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: dsh-chrome
      name: dsh-chrome
```

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `profileRoot` | `<DSH home>/chrome` | 每个实例一个目录；存在这里的登录态跨重启保留 |
| `executablePath` | `auto` | `auto` 依次尝试 `CHROME_PATH`、已安装的浏览器、常见安装路径 |
| `toolCallTimeoutMs` | `120000` | 单次 MCP 调用的上限；不影响租约 |
| `leaseTtlMs` | `1800000` | 兜底租约过期，只在查不到所属会话时生效 |
| `ephemeralCloseOn` | `turn` | 无头实例的关闭时机：`turn`、`session` 或 `manual` |
| `chromeArgs` | `[]` | 追加的 Chrome 命令行参数 |
| `screenshotDir` | `<profileRoot>/screenshots` | 截图落盘处，也是 MCP 服务唯一允许写入的目录 |

## 工具

| 工具 | 用途 |
|---|---|
| `chrome_browser_list` | 列出实例、端口、tab 数与租约归属 |
| `chrome_browser_open` | 开共享的 GUI 浏览器（`default`，已开则复用）或指定名字的无头实例（名字必填、互斥）；`profile` 指定共享 profile，`ephemeral` 用一次性 profile |
| `chrome_browser_close` | 关实例并释放它的租约 |
| `chrome_list_tabs` | 列出 tab 的 id、标题、URL 与占用者 |
| `chrome_search_tabs` | 按标题、URL 或两者过滤 tab |
| `chrome_open_tab` | 后台开一个 tab 并认领 |
| `chrome_close_tab` | 关 tab 并释放 |
| `chrome_release_tab` | 只释放租约，不关 tab |
| `chrome_inspect` | 无障碍快照、HTML 或可见文本 |
| `chrome_screenshot` | 截图落盘并返回路径 |
| `chrome_click` | 按 `chrome_inspect` 给的 uid 点击 |
| `chrome_type_text` | 向聚焦元素输入文本 |
| `chrome_navigate` | 打开 URL、后退、前进或刷新 |
| `chrome_evaluate` | 在页面里执行函数；逃生舱 |

## 行为

- 启动用 `--no-startup-window`，第一个页面经 CDP 以 `background: true` 创建，所以浏览器不会抢焦点。
- 启动参数带 `--disable-blink-features=AutomationControlled`：否则开着 DevTools 端口会让页面报告 `navigator.webdriver`，登录服务会因此拒绝这个浏览器。
- 无头实例默认在本轮结束时关闭；一次性 profile 随实例一起删除。
- 别的会话还在用时，实例不随创建者的轮次关闭：别处持有的 tab 优先于关闭策略，等没人占 tab 之后再回收。
- 插件加载时会清掉上个宿主留下的无头 profile；带界面的 profile 原样保留，因为登录态在里面。
- MCP 服务挂掉后，下一次调用会报 `browser_down`（page id 变了），之后的调用会重连。
- 每个实例跑一个 `chrome-devtools-mcp` 进程，挂载参数是 `--experimentalStructuredContent` 与 `--workspace=<screenshotDir>`。

## 已知限制

- page id 只在单个 MCP 进程内有效；进程重启后它与全部租约一起失效。
- 两个 Harness 宿主共用同一个 profile 目录时，租约不共享。
- 浏览器经 MCP 驱动，没有被这里包一层的能力（上游工具）用不了。
- 带界面的实例会一直跑，直到 `chrome_browser_close`——登录态正是它存在的理由。
- 共享 profile 归一个运行中的实例所有；第二个调用方会收到提示，说明被谁占着。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:browser
```

`pnpm run test:browser` 会启动真实的 headless Chrome；`pnpm run test:focus` 是 macOS 上的检查，确认带界面的启动不会改变前台应用。
