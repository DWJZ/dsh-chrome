---
description: "DeepSeek Harness 的专用 Chrome 实例：tab 级租约、按需实例、启动不抢焦点。"
kind: "plugin-reference"
---

# dsh-chrome

[English](README.md) | 中文

## 摘要

`dsh-chrome` 给 Harness agent 一批它能真正操控的浏览器。每个实例都是本插件自己起的 Chrome 进程，用独立的 profile 目录，所以不会碰你日常用的那个浏览器。工具经 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) 提供，一个实例一个 server。

实例名由 agent 自己起。`chrome_browser_open` 默认开带界面的浏览器（方便人登录），profile 跨重启保留；传 `headless: true` 则开无窗口的。重名会被拒绝，让调用方换一个。

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
| `chrome_browser_open` | 起实例；`name` 由 agent 起，重名直接失败 |
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
- 无头实例默认在本轮结束时关闭，profile 目录一并删除。
- 插件加载时会清掉上个宿主留下的无头 profile；带界面的 profile 原样保留，因为登录态在里面。
- MCP 服务挂掉后，下一次调用会报 `browser_down`（page id 变了），之后的调用会重连。
- 每个实例跑一个 `chrome-devtools-mcp` 进程，挂载参数是 `--experimentalStructuredContent` 与 `--workspace=<screenshotDir>`。

## 已知限制

- page id 只在单个 MCP 进程内有效；进程重启后它与全部租约一起失效。
- 两个 Harness 宿主共用同一个 profile 目录时，租约不共享。
- 浏览器经 MCP 驱动，没有被这里包一层的能力（上游工具）用不了。
- 带界面的实例会一直跑，直到 `chrome_browser_close`——登录态正是它存在的理由。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:browser
```

`pnpm run test:browser` 会启动真实的 headless Chrome；`pnpm run test:focus` 是 macOS 上的检查，确认带界面的启动不会改变前台应用。
