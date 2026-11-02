# dsh-chrome

DeepSeek Harness 浏览器插件：自己起专用 Chrome 实例，经 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) 暴露 tab 级工具，多个会话可以同时操作不同 tab，同一个 tab 同一时刻只归一个会话。 / Dedicated Chrome instances for DeepSeek Harness, with tab-level leases and agent-chosen instance names.

## 它做什么

- **自己起浏览器**：每个实例一个独立 `--user-data-dir`，不碰你日常用的 Chrome，也不 attach 外部实例。
- **不抢焦点**：Chrome 用 `--no-startup-window` 启动，第一个页面通过 CDP `Target.createTarget { background: true }` 创建；新 tab 一律后台打开。
- **多实例并存**：`chrome_browser_open` 默认开一个带 GUI 的实例（可以登录、登录态留在 profile 目录里），也可以 `headless: true` 开无头实例。
- **tab 级租约**：租约绑定 `(实例, tab, 会话)`，不是某一次调用。只有显式 `chrome_release_tab`、只读 tab、tab 被关、会话结束才释放；`toolCallTimeoutMs` 超时只让当次调用失败，不会没收 tab。
- **常驻与按需**：headed 实例只在显式 `chrome_browser_close` 时关闭；headless 实例按 `ephemeralCloseOn` 在轮次结束（默认）或会话结束时关闭，关闭时连同 profile 目录一起删掉。
- **孤儿清理**：每个 profile 目录里写一个 `.dsh-chrome-profile.json` 标记；插件加载时扫描 `profileRoot`，按标记把上个宿主留下的 headless 实例停掉并删目录，headed 的目录原样保留（登录态）。
- **MCP 崩溃恢复**：MCP 子进程断开时自动重启，但当前这次调用会报 `browser_down`（page id 变了），让调用方重新 `chrome_list_tabs`。

## 安装

```bash
cd <deepseek-harness checkout>
pnpm dsh plugin --profile web add link:/path/to/dsh-chrome
```

然后在 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-chrome
      name: dsh-chrome
```

改完重启宿主（或让 HMR 重载）生效。插件是普通依赖，不是 bundle，所以不会被自动选中。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `profileRoot` | `<DSH home>/chrome` | 每个实例一个子目录；存在里面的登录态会跨启动保留 |
| `executablePath` | `auto` | `auto` 依次尝试 `CHROME_PATH`、`chrome-launcher` 的安装探测、常见安装路径 |
| `toolCallTimeoutMs` | `120000` | 单次 MCP 调用的上限，不影响租约 |
| `leaseTtlMs` | `1800000` | 兜底租约过期；只有查不到所属会话是否还活着时才生效 |
| `ephemeralCloseOn` | `turn` | headless 实例的关闭时机：`turn` / `session` / `manual` |
| `chromeArgs` | `[]` | 追加的 Chrome 命令行参数 |
| `screenshotDir` | `<profileRoot>/screenshots` | 截图目录，同时作为 MCP 服务允许写入的 workspace 根 |

## 工具

| 工具 | 说明 |
|---|---|
| `chrome_browser_list` | 列出实例、端口、tab 数与租约归属 |
| `chrome_browser_open` | 开实例；`name` 由 agent 起，重名直接报错；`headless` 默认 `false` |
| `chrome_browser_close` | 关实例，释放它的全部租约 |
| `chrome_list_tabs` | 列 tab（id / 标题 / URL / 占用者） |
| `chrome_search_tabs` | 按 `title`、`url` 或 `both` 过滤，不做页内搜索 |
| `chrome_open_tab` | 后台开 tab 并认领 |
| `chrome_close_tab` / `chrome_release_tab` | 关 tab / 只释放租约 |
| `chrome_inspect` | `a11y`（默认）、`html`、`text` 三种读法 |
| `chrome_screenshot` | 截图落盘，返回路径 |
| `chrome_click` / `chrome_type_text` | 按 `uid` 点击、输入 |
| `chrome_navigate` | `url` / `back` / `forward` / `reload` |
| `chrome_evaluate` | 逃生舱：在页面里执行函数 |

`browser` 参数省略时用 `default`。

## 已知限制

- 每实例一个 MCP 子进程；`pageId` 是该进程内的编号，进程重启后全部作废，相关租约一并清空。
- 两个 DSH 宿主同时开时，租约不跨进程共享。
- `chrome-devtools-mcp` 通过 `--workspace=<screenshotDir>` 限制文件写入；要改截图目录就同步改配置。
- MCP 的 `list_pages` 结构化输出需要 `--experimentalStructuredContent`；插件在缺失时回退解析文本列表。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm run build
node --import tsx/esm test/run.mjs        # 租约单测，无网络无浏览器
node --import tsx/esm test/smoke.mjs      # 真 headless Chrome 冒烟
node --import tsx/esm test/focus-headed.mjs  # 校验 headed 启动不抢焦点（macOS）
node --import tsx/esm test/integration.mjs    # 多实例、租约互斥、页面工具、孤儿清理
```

`test/smoke.mjs` 与 `test/focus-headed.mjs` 会启动真实 Chrome；focus 测试用临时 profile，结束即清理。
