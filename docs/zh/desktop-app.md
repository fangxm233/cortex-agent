# 桌面与 Android 应用

Cortex 提供面向 Linux、macOS、Windows 与 Android 的 Tauri v2 原生壳。桌面端使用三栏工作台，Android 使用针对手机设计的四 Tab 界面。两者都通过 Web UI HTTP 传输直连 Cortex 服务器，并与浏览器工作台共享项目、会话、任务、线程、审批、文件和记忆。

原生应用需要可访问的 Web UI 端点和服务器的 `CORTEX_CLIENT_TOKEN`。浏览器访问采用独立的 Cloudflare Access 路径，详见[浏览器访问](browser-access.md)。

## 安装

对于包含原生安装包的 server release，可从 [GitHub Releases 页面](https://github.com/fangxm233/cortex-agent/releases)下载对应平台附件。Release policy 要求原生 UI 与对应 server release 使用完全相同的 CalVer，格式为 `YYYY.M.D[-N]`。应用内嵌版本和附件文件名中的版本必须与 `server-v<version>` tag 一致。

| 平台 | 原生 release 安装包 | 安装方式 |
|---|---|---|
| Linux x86_64 | AppImage、DEB 或 RPM | 对 AppImage 执行 `chmod +x` 后直接运行，或安装对应发行版软件包。 |
| Windows x86_64 | NSIS `setup.exe` | 运行安装程序，然后从开始菜单启动 Cortex。 |
| macOS universal | 同时支持 Intel 与 Apple Silicon 的 universal DMG | 打开 DMG，将 Cortex 拖入“应用程序”。 |
| Android arm64 | 已签名 APK | 打开 APK；Android 提示时，允许当前文件来源安装应用。 |

Linux AppImage 运行时需要 WebKitGTK 与 GTK。Ubuntu 和 Debian 用户可安装常见运行库：

```bash
sudo apt-get install libwebkit2gtk-4.1-0 libgtk-3-0
```

Windows 10 和 11 通常已包含 WebView2。如果 Cortex 报告缺少 WebView2，请先安装 Microsoft Evergreen WebView2 runtime。没有 Authenticode 证书的 release installer 也可能触发 Microsoft Defender SmartScreen 警告；选择运行前应核对发布者与 release checksum。

没有 Developer ID 证书的 macOS 安装包使用 ad-hoc 签名，但未经过 notarization。Gatekeeper 可能阻止首次普通双击启动。可在 Finder 中对 Cortex 使用一次**打开**操作，或在**系统设置 → 隐私与安全性**中批准。Ad-hoc 签名可校验 bundle 结构，但不提供受信任的发布者身份。

Android APK 面向 arm64 设备，并通过 Play Store 之外的方式分发。因此，Android 会要求允许用于打开 APK 的浏览器或文件管理器安装未知来源应用。

## 服务器配置

原生壳连接服务器上主动启用的 Web UI 端点。端点本身属于启动拓扑，仍留在服务器的 `$CORTEX_HOME/config/.env` 中：

```bash
CORTEX_UI_HTTP=1
CORTEX_UI_PORT=3004
```

允许的 CORS origin 是运行时设置。在 `$CORTEX_HOME/config/settings.json` 中添加或确认 `uiCorsOrigins` 键（见 [configuration.md](./configuration.md#configsettingsjson)）：

```json
{
  "uiCorsOrigins": [
    "cortexui://localhost",
    "http://cortexui.localhost",
    "tauri://localhost",
    "http://tauri.localhost"
  ]
}
```

`.env` 中逗号分隔的旧变量 `CORTEX_UI_CORS_ORIGINS` 仍作为已弃用的回退被读取。

`cortex init` 会在 `.env` 中生成 `CORTEX_CLIENT_TOKEN`。原生应用使用这个值；`CORTEX_TOKEN` 不是服务器端客户端 token 的配置名。可用以下命令读取已配置的 token：

```bash
grep CORTEX_CLIENT_TOKEN "${CORTEX_HOME:-$HOME/.cortex}/config/.env"
```

在 `.env` 中更改端点后需重启 daemon。改动 `uiCorsOrigins` 则无需重启——它在每个请求时解析。原生应用连接能够到达该端点的 HTTP 或 HTTPS URL。通过隧道暴露端点时，应使用可直接接受 Cortex token 的 hostname，而不是要求交互式浏览器 SSO 的地址。

当前构建通过 `cortexui` custom protocol 提供原生壳；根据 WebView 平台，origin 表现为 `cortexui://localhost` 或 `http://cortexui.localhost`。两个 `tauri` origin 用于保持旧版原生应用可连接。服务器只为 `uiCorsOrigins` 中明确列出的 origin 返回 CORS header。

## 首次连接

打开 Cortex，输入包含 `https://` 或 `http://` 的服务器 URL，以及 `CORTEX_CLIENT_TOKEN`。连接测试会区分端点不可访问和 token 未授权。连接成功后，应用打开工作台并保存凭据，供后续启动使用。

Linux、macOS 与 Windows 将连接 JSON 保存到操作系统密钥链，即 Secret Service、钥匙串或 Windows 凭据管理器。Android 将其保存到应用私有数据目录，因为桌面 keychain 库没有 Android backend。执行 Disconnect 会清除相应平台存储并返回连接界面。

## 桌面工作台

桌面应用与浏览器使用同一个三栏工作台。左侧导航栏列出项目和项目范围内的会话，并提供当前项目的 Overview 入口。中间区域包含对话、流式智能体输出、工具活动、附件、问题卡片与计划审批。右侧面板可在 Threads、Tasks 与 Machines 之间切换，显示当天项目费用，也可由私人 Notes 面板替代。

线程卡片会打开 modal，显示实时 pipeline、各步骤、嵌套线程与持久化 artifact。执行条目会打开带实时日志和取消控制的 drawer。在 macOS 上按 `⌘K`，或在 Linux 与 Windows 上按 `Ctrl+K`，可打开命令面板。

如需切换服务器，打开 daemon 或连接状态，选择 **Disconnect**，然后在连接界面输入新的端点和 token。

## Android 界面

Android 使用四个底部 Tab：Sessions、Threads、Tasks 与 Project。会话聊天、计划阅读、线程详情、任务详情、审批、问题、笔记、记忆文件、机器、设置、hooks 与 daemon 状态以 drill-in 页面打开。Android 返回操作会先关闭 overlay，再沿应用导航栈返回。

原生通知会报告已完成的 turn，并可返回相关会话。Cortex 下载的文件会交给 Android `DownloadManager`，写入公共 Downloads collection，并显示系统完成通知。

## 文件与下载

| 界面 | 下载行为 |
|---|---|
| 浏览器 | 使用浏览器自带的下载管理器。 |
| Linux、macOS、Windows | 优先使用操作系统 Downloads 目录，不可用时回退到应用本地 downloads，并在完成后提供 **Open file** 与 **Open folder** 操作。 |
| Android | 使用系统 DownloadManager 与公共 Downloads collection。 |

工作台可直接预览图片与视频、分页查看 PDF，并显示文本文件，无需先用其他程序打开。桌面用户还可以将预览固定在聊天旁边，继续对话。

## 版本与前端更新

带 tag 的原生 release 与 `@cortex-agent/server` 使用同一版本。这个共享 CalVer 标识 server release，以及从该 tag commit 构建的全部原生安装包。

## 更新

应用使用两条更新通道，两者都由所连接的服务器协调。

### 前端工作台

启动后，原生壳会比较本地 SPA 与服务器提供的 content-addressed frontend bundle。发现新 bundle 后，应用在后台下载、校验 SHA-256 digest、完成 staging，并在可通过重启应用时提示。这条通道更新 Web 工作台，不会替换原生 executable 或 APK。

### 原生应用壳

Server release 也可以在 GitHub Release 中携带原生安装包。服务器只会通告不高于自身版本的最新可安装 release。原生壳按操作系统、架构与 package kind 选择附件，直接从 GitHub 下载且不会转发 Cortex token，并在提供安装选项前校验 GitHub 提供的 SHA-256 digest。更新对话框支持立即安装、跳过该版本或稍后处理。

| 平台 | 原生更新行为 |
|---|---|
| Linux AppImage | 原地替换当前 AppImage，保留一份 `.old` 备份，重新启动后退出旧进程。 |
| Linux DEB 或 RPM | 将已校验的软件包复制到 Downloads，并打开系统 package installer。 |
| Windows | 启动已校验的 NSIS installer，然后退出，以便安装程序替换应用。 |
| macOS | 将已校验的 DMG 复制到 Downloads 并打开；将 Cortex 拖入 Applications 后完成安装。 |
| Android | 对已校验的 APK 打开系统 package installer；Android 会在需要时请求 install-source 权限。 |

运行中的线程在服务器上执行，因此重启或重新安装客户端不会停止它们。设置了 `CORTEX_FRONTEND_DIR` 的开发运行、未携带 CalVer release version 的应用，或设置 `CORTEX_APP_UPDATE_DISABLE=1` 时，都不会检查原生壳更新。

## 故障排查

### Unauthorized

确认应用中填写的是 `CORTEX_CLIENT_TOKEN`，而不是 webhook token 或旧变量。如果服务器 token 已改变，先使用 Disconnect，再重新输入。

### Network error

确认 daemon 正在运行、`CORTEX_UI_HTTP=1` 已加载、URL 能访问配置端口，且隧道正在工作。页面可加载但 API 全部失败时，通常是 token 或 CORS 问题。确认 `config/settings.json` 中的 `uiCorsOrigins` 设置包含当前的 `cortexui` origins；如果还有旧版应用连接服务器，请保留 `tauri` origins。

### Linux 上凭据无法持久化

无头 Linux 环境可能没有 Secret Service daemon。此时 keychain 写入失败，凭据只能保留到当前进程结束。可在本地启动时显式注入连接信息：

```bash
CORTEX_SERVER_URL=http://localhost:3004 CORTEX_TOKEN=<client-token> ./Cortex.AppImage
```

此启动命令中的 `CORTEX_TOKEN` 是原生壳的 fallback 变量；服务器配置仍使用 `CORTEX_CLIENT_TOKEN`。

### Wayland 下应用窗口不显示

Tauri 支持 Wayland，但具体系统的 WebKitGTK 问题可能需要使用 X11 compatibility：

```bash
GDK_BACKEND=x11 ./Cortex.AppImage
```
