# 桌面应用

Cortex 桌面应用是一个原生窗口程序（基于 [Tauri v2](https://tauri.app) 构建），
用于包装 Cortex 网页工作台。它通过 HTTP tRPC 传输和 `clientToken` 直连任何运行中的
Cortex 服务器——无需本地代理或 sidecar 进程。

## 安装

从 [GitHub Releases 页面](https://github.com/fangxm233/cortex-agent/releases) 下载适合你平台的最新版本。

### Linux

**AppImage（适用于任何发行版）：**

```bash
chmod +x Cortex_*.AppImage
./Cortex_*.AppImage
```

**Debian / Ubuntu (.deb)：**

```bash
sudo apt install ./Cortex_*_amd64.deb
cortex-desktop          # 或从应用程序菜单启动
```

**系统前置依赖（Ubuntu 22.04+）：**

```bash
sudo apt-get install libwebkit2gtk-4.1-0 libgtk-3-0
```

大多数 Ubuntu/Debian 桌面系统已预装这些库。如果应用因缺少库而无法启动，
请运行上述命令安装。

### macOS

下载 `Cortex_*_x64.dmg`（Intel）或 `Cortex_*_aarch64.dmg`（Apple Silicon）。

1. 打开 `.dmg` 文件。
2. 将 **Cortex** 拖入 **应用程序** 文件夹。
3. 从应用程序或 Spotlight 打开 **Cortex**。

首次启动时 macOS 可能提示"Apple 无法验证此开发者"。在
**系统设置 → 隐私与安全性** 中点击 **仍要打开**。

### Windows

下载 `Cortex_*_x64-setup.exe`，运行安装程序并按提示操作。
安装完成后，Cortex 出现在开始菜单中。

**WebView2 依赖：** Windows 10 / 11 通常已包含 WebView2 运行时。如果应用因 WebView2 错误
无法启动，请从 [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/)
下载常青版引导程序并安装。

## 服务器端前置条件

桌面应用通过 HTTP 或 HTTPS 与 Cortex 服务器的 **Web UI HTTP 端点** 通信。
该端点是**可选启用**的——连接前必须先在服务器上启用它。

该端点由服务器**内置**的 Web UI 传输层提供，核心服务器仅在设置了 `CORTEX_UI_HTTP` 时才按需
加载它（它携带 `@trpc/server` + `jose` 与 SPA 托管——运行期惰性加载，因此仅 Slack/TUI 的
服务器永不加载它们）。启用它与此前一样只需一行标志——**桌面应用不受任何影响**，它仍以
Bearer `clientToken` 认证。同一端点也驱动浏览器工作台，见
[浏览器访问与部署](browser-access.md)。

在运行 Cortex 服务器的机器的 `~/.cortex/config/.env` 中添加以下内容：

```bash
CORTEX_UI_HTTP=1          # 启用 tRPC HTTP + SSE 端点
CORTEX_UI_PORT=3004       # 可选，默认为 3004
```

然后重启 Cortex 守护进程：

```bash
cortex daemon   # 或 systemctl --user restart cortex（如果已注册系统服务）
```

如果通过隧道暴露该端点（推荐用于远程访问），将隧道指向上述端口，
在桌面应用中使用隧道的 HTTPS URL 进行连接。

## 首次启动：连接到你的服务器

首次启动 Cortex 桌面应用时，会出现**连接配置界面**：

```
┌─────────────────────────────────────────────────────────┐
│  cortex-desktop                                         │
│                                                         │
│  server url                                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │  https://cortex.example.com                      │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  client token                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  ••••••••••••••••••                              │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│           [test connection]   [connect →]               │
└─────────────────────────────────────────────────────────┘
```

### 第一步 — 输入服务器 URL

输入 Cortex Web UI 端点可访问的 HTTP/HTTPS URL，例如：

- 同一台机器，无隧道：`http://localhost:3004`
- 通过 Cloudflare 隧道访问远程服务器：`https://cortex-ui.your-domain.com`

### 第二步 — 输入客户端令牌

客户端令牌是服务器用于验证 Cortex 客户端的共享密钥（与 `~/.cortex/config/.env` 中
`CORTEX_TOKEN` 的值相同）。可以通过以下命令获取：

```bash
grep CORTEX_TOKEN ~/.cortex/config/.env
```

### 第三步 — 测试连接

点击 **test connection**。应用会向 `<serverUrl>/trpc` 发送一个携带令牌头的轻量探测请求。

- **Connected**（绿色）—— 服务器可达且令牌有效。
- **Unauthorized**（橙色）—— 服务器可达但令牌错误。
- **Network error**（红色）—— URL 不可达（服务器未运行、隧道未启动或 URL 错误）。

### 第四步 — 连接

点击 **connect →**。应用将：

1. 把凭据保存到操作系统密钥链（macOS 钥匙串、Windows 凭据管理器或
   Linux SecretService / GNOME 密钥环）。
2. 打开工作台。

之后每次启动时，Cortex 都会读取存储的凭据并直接打开工作台，跳过连接配置界面。

## 使用说明

连接成功后，你可以使用完整的 Cortex 工作台。

### 主工作台

工作台采用三栏布局：

| 栏位 | 内容 |
|---|---|
| 左侧导航栏 | 项目/会话导航器，可切换项目和会话存档。 |
| 中央区域 | 对话内容：线程步骤、工具调用、助手输出、审批提示。 |
| 右侧面板 | 活跃线程/任务/机器；成本条；步骤详情树。 |

### 线程详情

点击右侧面板中的任意线程卡片，打开**线程详情视图**——包含智能体规划、执行过程和
子派发链的完整逐步追踪，以及每步的耗时和成本。

### ⌘K / Ctrl+K — 命令面板

按 `⌘K`（macOS）或 `Ctrl+K`（Windows/Linux）打开命令面板。输入文字可在会话、线程和
任务中快速过滤。按 Enter 跳转，按 Escape 关闭。

### 执行日志抽屉

在右侧面板或线程详情中点击运行中的执行条目，打开**执行日志抽屉**——
实时流式显示执行过程的标准输出/标准错误。日志通过 SSE 实时推送，
**Kill** 按钮可取消执行。

### 项目与存档切换器

左侧导航栏显示当前项目。点击项目名称打开**项目切换器**，选择其他项目。
点击存档图标可切换到历史存档视图。

### 任务弹窗

点击右侧面板或命令面板中的任意任务行，打开**任务弹窗**，显示任务的完整描述、
`done-when` 完成条件、当前状态和依赖链。

### 概览

右侧面板的 **Overview** 标签页显示全系统的成本、定时任务、近期执行记录和吞吐量图表。

## 切换到其他服务器

在工作台窗口中移动鼠标时，右下角会出现 **Switch** 按钮。点击后：

1. 从操作系统密钥链中清除已存储的凭据。
2. 返回连接配置界面。

然后可以输入新的服务器 URL 和令牌。

## 更新

应用通过两条通道保持最新，两条都由所连接的服务器驱动，无需手动检查新版本。

**前端（静默）。** 启动后，应用会将自带的 Web UI 与服务器提供的版本对比。当服务器有更新的
UI 时，应用在后台下载、校验并暂存到下次启动生效——就绪后会出现一个"重启更新"的小提示。
大多数发布都走这条通道：只改 UI 的版本以这种方式到达，无需重装。

**原生壳（每次发布最多一次提示）。** 部分发布还会附带新的原生安装包（挂在 GitHub release
上）。服务器只会通告与自身版本匹配的最新安装包——应用永远不会被推送比所连服务器更新的
版本，因此两端始终保持同步，一次发布在每台设备上最多产生一次更新提示。应用会在后台下载
对应平台的安装包，用 GitHub 发布的 SHA-256 摘要校验，然后弹出对话框，提供三个选择：
立即更新、跳过此版本、稍后。

"立即更新"在各平台的行为：

- **Linux（AppImage）** —— 应用原地替换自身文件（旧版保留为旁边的 `.old`）并重启，全自动。
- **Windows** —— 应用退出并启动下载好的安装程序，按提示完成后重新打开 Cortex。
- **macOS** —— 磁盘映像保存到"下载"并自动打开，把 Cortex 拖入 Applications 即完成。
- **Linux（deb/rpm）** —— 安装包保存到"下载"并用系统安装器打开。
- **Android** —— 系统安装器在校验过的 APK 上弹出，确认即升级。首次使用时 Android 会
  请求允许来自 Cortex 的安装。

运行中的线程都在服务器上执行，重启或重装应用不会打断它们。开发模式（通过
`CORTEX_FRONTEND_DIR` 从本地目录提供 SPA 的运行方式）不会检查壳更新。在应用环境中设置
`CORTEX_APP_UPDATE_DISABLE=1` 可完全关闭检查。

## 连接机制

桌面应用通过以下方式绕过浏览器的同源限制：

- **tRPC HTTP 批量请求**：通过 `POST <serverUrl>/trpc` 发送所有查询和变更，
  每个请求携带 `x-cortex-token` 头。
- **SSE 订阅**：使用支持自定义请求头的 EventSource 腻子脚本（fetch-based）。
  线程和执行的实时更新无需轮询即可到达。

这种架构使桌面应用可以连接到任意机器上的任意 Cortex 服务器——本地或远程——
只要 Web UI 端点可访问即可。

## 故障排查

**测试连接时显示"Unauthorized"**

客户端令牌错误。请检查服务器上 `~/.cortex/config/.env` 中的 `CORTEX_TOKEN`。

**测试连接时显示"Network error"**

1. 确认服务器正在运行：`cortex daemon`（或检查 `systemctl --user status cortex`）。
2. 确认服务器的 `.env` 中已设置 `CORTEX_UI_HTTP=1`，且添加后已重启服务器。
3. 检查 URL 是否可访问：`curl <serverUrl>/trpc` 应返回 tRPC 错误（而非连接拒绝错误）。
4. 如使用隧道，确认隧道正常运行且路由指向正确端口。

**重启后凭据丢失（Linux 无头服务器）**

在没有 SecretService 守护进程的 Linux 无头服务器上（例如未运行 GNOME 密钥环的服务器），
操作系统密钥链不可用。凭据仅在当前会话中保留（存储在进程内存中），
应用退出后即丢失。

解决方案：在启动应用前设置环境变量：

```bash
CORTEX_SERVER_URL=http://localhost:3004 CORTEX_TOKEN=<your-token> ./Cortex.AppImage
```

这些环境变量会在启动时初始化 AppState，跳过密钥链检查。

**Wayland 下应用窗口不显示**

Tauri v2 支持 Wayland。如果窗口未出现，可尝试强制使用 X11 兼容模式：

```bash
GDK_BACKEND=x11 ./Cortex.AppImage
```
