# Agent 浏览器 {#agent-browser}

Cortex 里的 agent 操作的是真实的 Chrome：打开页面、阅读、点击、填表、截图。这个浏览器是 Cortex 在服务器上管理的那个
Chrome，或者某台已连接机器上的 Chrome；你可以在 App 里实时观看，页面需要人来处理时可以接管。

Agent 通过 `cortex-browser` 命令控制它，这个命令和其他工具一样在 agent 的 shell 里运行。内置的 `browser` skill
（在 `cortex-system` 插件里）告诉 agent 什么时候用、怎么用，所以直接说「看一下这个页面」「给仪表盘截个图」「登录后看看」就够了。

## Agent 怎么用它 {#how-an-agent-uses-it}

`cortex-browser` 就是连到 Cortex 所管理 Chrome 上的 [agent-browser](https://github.com/vercel-labs/agent-browser)。
除 `--device` 外的所有参数都交给 agent-browser，所以命令集就是 agent-browser 的：`open`、`snapshot`、`click`、`fill`、
`screenshot`、`get`、`eval` 等。常见的流程是：

```bash
cortex-browser open http://127.0.0.1:5173
cortex-browser snapshot -i              # 可交互元素以 ref 列出：@e1、@e2 …
cortex-browser click @e2
cortex-browser screenshot ./after.png
```

与版本匹配的完整命令指南随二进制一起提供：`cortex-browser skills get core`（加 `--full` 列出全部命令和选项）。
`cortex-browser` 自己额外做了什么、拒绝什么，见 [CLI 参考](cli-reference.md#cortex-browser)。

相对文件路径（`screenshot ./page.png`、`pdf out.pdf`、`upload @e5 a.png`）按 agent 的工作目录解析。不管截图来自哪台机器的
Chrome，文件都落在服务器上；agent 用 `send_file` 把截图发给你。

## 每个会话一个 tab {#one-tab-per-session}

每个会话都有自己的 tab；worker 和 subagent 也各有一个，因为它们本身就是独立的会话。Tab 在多轮之间保留，agent 会接着上次的页面继续。
会话之间从不共用 tab，也看不到彼此的 tab。

一个会话连续 10 分钟没有调用 `cortex-browser`，它的 tab 就会关闭。下一次调用从空白页开始并会说明这一点，agent 再重新打开需要的 URL。
如果 Chrome 因为别的原因停了，比如崩溃或机器重启，下一次调用会重新启动 Chrome，同样接着进行。最后一个会话的 tab 关闭 10 分钟后，
Chrome 本身也会退出。

登录状态保存在浏览器 profile 里，而不是 tab 里，所以登录过的网站在之后的 tab 和之后的会话里仍然保持登录。服务器上的 profile 是
`$CORTEX_HOME/browser/profile/`（默认 `~/.cortex/browser/profile/`）；设备上则是运行 `cortex-client` 的用户主目录下的
`~/.cortex/browser/profile/`。它们都与你日常使用的 Chrome profile 分开。

## 选择机器 {#choosing-the-machine}

- **`server`**（默认）是 Cortex 服务器上的 Chrome，在那里 `localhost` 指服务器。服务器有显示器时它运行在该显示器上，否则运行在虚拟
  显示器上（需要安装 `Xvfb`）或以 headless 方式运行。App 里的实时画面和接管走的是 Chrome 的调试连接，所以哪种情况都能用。
- **`--device <name>`** 改用某台已连接机器上的 Chrome：用它的 `localhost`、它的网络和它的登录状态。Cortex 通过该机器的
  `cortex-client` 启动那个 Chrome，并经客户端的[端口转发](cross-machine.md#port-forwarding)访问它的调试端口，所以那台机器上不需要额外开放任何东西。
  那台机器上需要装有 Chrome 或 Chromium。

选择会一直生效：一个会话用过某台设备后，之后的调用不用再写 `--device` 也会去那里。换到另一台机器时，会话在上一台机器上的 tab 会被关闭。
你要求用你自己的机器，或者页面只在那台机器上存在时，agent 会选择对应的设备。

浏览器用不了时，`cortex-browser` 以非零码退出，并说明原因和下一步：设备离线或未知、Chrome 启动失败，或者你正在操作这个浏览器。

## 在 App 里观看 {#watching-it-in-the-app}

会话有浏览器时，对话头部会显示一个**浏览器**胶囊，标出所在机器和浏览器状态：启动中、启动失败、正在某个页面，或**你正在操作**。点击它会在停靠栏
打开该会话的 **Agent 浏览器**标签页，实时显示页面。命令面板（`⌘K` / `Ctrl+K`）把所有正在运行的 agent 浏览器列在 **Agent 浏览器**分组下，
在任何会话里都能打开。画面只在标签页可见时传输。

在手机上，对话的活动条会显示浏览器小标签，点开是该页面的只读画面。

## 接管 {#taking-over}

有些页面需要人来处理：登录、验证码、二次验证，或者 agent 关不掉的 cookie 弹窗。Skill 要求 agent 遇到这些时来问你，而不是设法绕过。接手的步骤：

1. 打开该会话的 **Agent 浏览器**标签页，按**接管**。
2. 直接操作页面：点击、滚动和按键都会送到页面上。标签页里的文本框会把文字输入到当前获得焦点的元素，从剪贴板粘贴也一样。
3. 按**交还**，然后在对话里回复，agent 会在同一个 tab 里继续。

你操作期间，agent 的 `cortex-browser` 调用会被拒绝并提示「the user is controlling this browser」，agent 会等你。接管属于发起它的那个窗口；
另一个窗口也可以把接管转到自己这里。发起接管的窗口的画面消失 30 秒后（停靠标签页被关闭、页面重新加载、网络断开），或者 10 分钟内没有点击、
按键或粘贴，Cortex 会自动把浏览器交还给 agent。

## 配置 {#configuration}

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CORTEX_AGENT_BROWSER_BIN` | Cortex 随附的 agent-browser 二进制 | `cortex-browser` 运行的 agent-browser 二进制的绝对路径。路径不存在时直接报错，不会退回其他二进制 |
| `CORTEX_BROWSER_BINARY` | 自动检测 | 服务器上浏览器使用的 Chrome 或 Chromium 二进制 |
| `CORTEX_BROWSER_DISPLAY` | 自动检测 | 服务器上浏览器使用的 X display，跳过 display 检测 |

Cortex 使用自己固定版本的 agent-browser，从不使用 `PATH` 上找到的那个，因此命令指南总是和命令一致。这些变量放在哪里，见
[配置](configuration.md#tuning-and-debugging)。
