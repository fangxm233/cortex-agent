# 浏览器访问与部署 {#browser-access-deployment}

Cortex 提供一个浏览器工作台——与[桌面应用](desktop-app.md)所包装的是同一个 SPA——
无需安装任何东西，即可从任意浏览器访问。本页同时覆盖**部署运行手册**（构建 SPA、
在服务器上启用 Web UI 端点）和**浏览器访问路径**（经 Cloudflare Access 边缘登录访问）。

访问工作台有三条彼此独立的路径，它们的认证方式不同：

| 路径 | 使用者 | 认证方式 | 是否持有 `clientToken`？ |
|---|---|---|---|
| **浏览器 + Access** | 任何有浏览器的人 | Cloudflare Access 边缘登录（邮箱 / IdP），由服务器以 JWT 校验 | **否**——浏览器从不接触令牌 |
| **浏览器 + token 登录** | 知道 token 的人 | 粘贴一次 token，换成 HttpOnly 会话 cookie | **否**——只有服务器看到，且只看到一次 |
| **桌面（Tauri）** | 已安装的桌面应用 | 存于操作系统密钥链的 Bearer `x-cortex-token`（即 `clientToken`） | 是 |

本页是浏览器访问 + 部署参考。安装原生桌面应用请见 [桌面应用](desktop-app.md)。

## 内置的 Web UI 传输层 {#the-in-core-web-ui-transport}

Web UI 传输层**内置**于 `@cortex-agent/server`，按需在 `CORTEX_UI_HTTP` 标志后加载。它携带
`@trpc/server` 与 `jose`，但二者是**运行期惰性**的：服务器仅通过一个只有在标志设置时才会到达
的动态 import 加载传输层。标志未设置时，传输层代码与 `@trpc/server` / `jose` 都不会进入运行时
模块图，因此仅用 Slack 或 TUI 的部署不承担任何 UI 负担——同时安装与升级仍是一条
`npm install -g @cortex-agent/server`。

启用后，该传输层：

- 以**同源**方式提供构建后的 SPA（`web/dist`）与 tRPC API——同一端口、同一 origin，
  浏览器加载 `index.html` + 资源并调用 `/trpc`，无需任何跨域处理；
- 在 `/trpc` 暴露 tRPC API（查询/变更走 HTTP 批量，订阅走 SSE），进程内直连服务器的
  domain 服务（无代理、无 sidecar）；
- 每个 `/trpc` 请求都经过**双路认证**门控（见 [认证](#authentication)）。

它与服务器运行在同一进程中，绑定到 `127.0.0.1`，设计上只应通过隧道对外暴露。

## 部署运行手册（源码 → 运行中的服务器） {#deployment-runbook-source-running-server}

以下步骤将你从全新检出带到一台提供浏览器工作台的 Cortex 服务器。

### 1. 前置条件 {#1-prerequisites}

- Node.js ≥ 20 与 [pnpm](https://pnpm.io)（本仓库是 pnpm workspace）。
- 一台运行中的 Cortex 服务器（见 [快速入门](quickstart.md)）。

### 2. 构建 SPA {#2-build-the-spa}

网页 SPA 构建产物位于 `web/dist`。在仓库根目录：

```bash
pnpm install            # 安装 workspace 依赖
pnpm -r run build       # 构建每个 workspace 包，包括 web → web/dist
```

只构建 SPA 及其依赖：

```bash
pnpm --filter @cortex-agent/ui-contract run build
pnpm --filter web run build      # 产出 web/dist
```

`web/dist` 是一个纯静态产物（`index.html` + 带哈希的资源）。发布 `@cortex-agent/server` 包时，
`web/dist` 会被打包进包内（通过 `prepack` 步骤）并随包的 `files` 一同发布，因此已安装的服务器
无需额外构建即可提供 SPA。从源码检出时，你用上面的步骤自行构建它。

### 3. `web/dist` 从何处被提供 {#3-where-webdist-is-served-from}

服务器按以下顺序解析 SPA 目录：

1. 你显式传给它的目录；
2. `CORTEX_UI_SPA_DIR` 环境变量；
3. 包根目录的 `web/dist`（存在于已安装/已发布的包中）；
4. monorepo 的 `web/dist`（从源码检出运行时）。

如果你部署已安装的包，第 3 项开箱即用。如果你从仓库检出部署，第 4 项无需配置即可生效——
就地构建 `web/dist` 便会被自动提供。如果你把构建后的 SPA 部署到其他位置，用
`CORTEX_UI_SPA_DIR` 指向它。如果目录不存在（SPA 未构建），非 `/trpc` 路径返回 404 占位，
而 `/trpc` 仍可工作。

### 4. 启用 Web UI 端点 {#4-enable-the-web-ui-endpoint}

在服务器的 `~/.cortex/config/.env` 中添加：

```bash
CORTEX_UI_HTTP=1          # 主动开启：启动 tRPC HTTP + SSE 端点（必需）
CORTEX_UI_PORT=3004       # 可选，默认为 3004
```

`CORTEX_UI_HTTP` 接受 `1`、`true`、`on` 或 `yes`。未设置时，该端点——以及 Web UI 传输层
连同 `@trpc/server` / `jose`——都不会加载。

仅这一项就足以让浏览器打开工作台：token 登录默认开启，SPA 会询问 `clientToken` 并把它换成
一个会话（见[用 token 登录的浏览器访问](#browser-access-with-a-token-no-cloudflare)）。

### 5. 重启守护进程以生效 {#5-restart-the-daemon-to-apply}

守护进程在启动时读取 SPA 与环境变量，因此新的构建或环境变量更改需在重启后生效：

```bash
cortex daemon   # 或：systemctl --user restart cortex（如果已注册系统服务）
```

!!! warning "重启具有中断性"
    重启守护进程会中断所有进行中的智能体、线程与定时任务。请将其视为一次审慎、
    受控的操作——在系统空闲时执行；如果你的 Cortex 实例运行在审批策略之下，
    请让重启走该审批步骤，而非随意重启。

此时服务器**仅在服务器主机上**可通过 `http://127.0.0.1:3004` 访问。把它暴露给浏览器
是下一节的内容。

## 认证 {#authentication}

`/trpc` 认证门在三种凭据中**任一**有效时放行请求，否则在 tRPC 运行前返回 `401`：

1. **`x-cortex-token` 头** 等于服务器的 `clientToken`——桌面 / 机器路径。优先检查，
   使用常量时间比较。与此前完全一致。
2. **有效的 `cortex_ui` 会话 cookie**——token 登录的浏览器路径。浏览器通过
   `POST /api/ui/login` 证明自己知道 token（仅一次）后由服务器签发。
3. **有效的 `Cf-Access-Jwt-Assertion` 头**——Cloudflare Access 的浏览器路径。边缘在认证
   用户后注入该 JWT，由服务器校验。

两条浏览器路径都不会把 `clientToken` 留在页面里：cookie 是 `HttpOnly` 的，SPA 自己的
JavaScript 读不到；Access JWT 则由边缘签发。

服务器针对你的 Cloudflare Access team-domain JWKS 校验 Access JWT，检查签名（仅
RS256 / ES256）、受众（AUD）标签、签发者与过期时间。如果服务器上**未**配置 Access，
JWT 路径被禁用，认证门安全降级——未配置的 Access 路径绝不放行任何请求。

!!! warning "端口转发是有意只认 token 的"
    `/forward`（桌面外壳到服务器 loopback 服务的裸 TCP 隧道）**只**接受 `x-cortex-token` 头，
    两种浏览器凭据都打不开它。浏览器会自动把 cookie 附加到 WebSocket 握手上，所以一旦在这里
    接受会话 cookie，等于把本机每个 loopback 服务的裸 socket 交给每一个已登录页面。

## 经 Cloudflare Access 的浏览器访问 {#browser-access-via-cloudflare-access}

浏览器路径在一个**专用 UI hostname 前放置 Cloudflare Access 边缘登录**，用户在边缘用
邮箱 / IdP 登录，服务器只会看到已被验证的请求。

```
浏览器
  │  https（Cloudflare Access：在边缘用邮箱 / IdP 登录）
  ▼
Cloudflare Tunnel   (cortex-ui.example.com  →  服务器 localhost:3004)
  │  边缘在每个请求上注入  Cf-Access-Jwt-Assertion
  ▼
agent-server Web UI 传输层  （校验 JWT；浏览器从不持有 clientToken）
  ├─ 提供 web/dist  （同源 SPA）
  └─ 提供 /trpc     （同源真实数据，进程内直连）
```

### 1. 建立专用 UI hostname 与隧道路由 {#1-create-a-dedicated-ui-hostname-and-tunnel-route}

将一条 Cloudflare Tunnel 路由从一个**新的**公开 hostname（例如 `cortex-ui.example.com`）
指向服务器的 loopback 端点（`http://127.0.0.1:3004`，或你的 `CORTEX_UI_PORT`）。

!!! danger "与 cortex-client 端点使用不同的 hostname"
    你的远程 `cortex-client` 实例所连接的 hostname **绝不能**放在 Cloudflare Access 之后
    ——Access 会挡住这些 WebSocket 客户端。始终给浏览器 UI 一个**独立**的 hostname，
    只对这一个应用 Access。

### 2. 添加 Cloudflare Access 应用（账户侧运维） {#2-add-a-cloudflare-access-application-account-side-ops}

在 Cloudflare Zero Trust 面板中，为该 UI hostname 创建一个 **self-hosted Access 应用**，
策略放行你的登录邮箱（或 IdP 群组）。这是在 Cloudflare 面板中执行的账户级操作，不在
Cortex 配置里。记下该应用的 **AUD 标签**——下一步需要用到。

### 3. 配置服务器校验 Access JWT {#3-configure-the-server-to-verify-access-jwts}

在服务器的 `~/.cortex/config/.env` 中添加：

```bash
CORTEX_ACCESS_TEAM_DOMAIN=your-team      # 裸 team 名，或 your-team.cloudflareaccess.com
CORTEX_ACCESS_AUD=<你的-Access-应用-AUD>  # Access 应用的 AUD 标签
# CORTEX_ACCESS_CERTS_URL=...            # 可选：覆盖推导出的 JWKS URL
```

服务器从 `CORTEX_ACCESS_TEAM_DOMAIN` 推导出签发者
（`https://your-team.cloudflareaccess.com`）与 JWKS URL
（`https://your-team.cloudflareaccess.com/cdn-cgi/access/certs`）。如果
`CORTEX_ACCESS_TEAM_DOMAIN` 或 `CORTEX_ACCESS_AUD` 有**任一**未设置，浏览器路径保持禁用
（仅令牌）。更改这些值后需重启守护进程。

### 4. 打开工作台 {#4-open-the-workbench}

访问 `https://cortex-ui.example.com`。Cloudflare Access 要求你用邮箱 / IdP 登录；认证后，
边缘在每个请求上转发经校验的 `Cf-Access-Jwt-Assertion`，服务器提供同源 SPA，工作台加载
真实 tRPC 数据——无需令牌，无需本地安装。

## 用 token 登录的浏览器访问（不需要 Cloudflare） {#browser-access-with-a-token-no-cloudflare}

如果你没有部署 Cloudflare Access——或者只是想从局域网里的笔记本、或经由 SSH 转发打开工作台
——浏览器可以通过粘贴一次服务器的 `clientToken` 来完成认证。

只要服务器开了 `CORTEX_UI_HTTP=1`，**此功能默认开启**。打开 UI 时，如果该浏览器还没有会话，
SPA 会先显示登录页而不是工作台：

```
浏览器  ──POST /api/ui/login {token}──▶  服务器   （与 clientToken 做常量时间比较）
       ◀──Set-Cookie: cortex_ui=… ; HttpOnly; SameSite=Strict; Secure──
浏览器  ──之后每个 /trpc、/api 请求都自动携带该 cookie──▶  服务器
```

它带来什么，代价是什么：

- **token 只提交一次**，随即被换成一个不透明的 32 字节会话 id。cookie 是 `HttpOnly` 的，
  页面 JavaScript——包括 XSS 注入的脚本——读不回去。
- **`SameSite=Strict`** 意味着任何跨站请求都不会携带该会话，CSRF 问题到此为止。登录 POST 还会
  额外拒绝 `Origin` 不是本机的请求。
- **会话能扛过守护进程重启**：它们存放在 `~/.cortex/data/ui-sessions.json`（权限 `0600`），
  签发 30 天后过期。设置 → 高级里有「退出此浏览器的登录」按钮，会在服务端吊销该会话。
- **会话的权限严格弱于 token**：它与 Cloudflare Access 登录的权限完全相同——tRPC 与 `/api`
  路由，永远不含 `/forward`。
- **登录端点是公开的**。它必须如此：没有任何凭据的浏览器得够得着它。token 错误会让调用方固定
  等待 250 毫秒并被记入日志；而 token 本身是 32 字节随机数，在线爆破并不现实。这里有意不做
  IP 封禁（在隧道后面所有请求看起来都来自 `127.0.0.1`）也不做全局锁定（那会让任何人把你自己
  锁在门外）。

### 调整或关闭 {#tuning-or-turning-it-off}

```bash
CORTEX_UI_TOKEN_LOGIN=0          # 彻底移除登录路由与 cookie 这条腿
CORTEX_UI_SESSION_TTL_DAYS=30    # 可选；会话有效期，默认 30 天
```

关闭之后，服务器的行为与本功能出现之前完全一致：只剩 header token 与（若已配置）Cloudflare
Access。SPA 会在登录页如实说明这一点，而不是给出一个根本不可能成功的表单。

### 该用哪一条 {#where-to-use-which}

当你希望由 IdP 管理访问、且访问者永远不该看到 token，或者 UI 直接暴露在公网上时，
在 UI hostname 前放 Cloudflare Access。当是你自己访问、且到服务器的通路本就私密或已加密
（隧道、VPN、Tailscale、SSH 转发、本机 loopback）时，用 token 登录。两者可以共存：同一台
服务器可以都开，每个请求按它携带的凭据被放行。

!!! note "局域网上的纯 HTTP"
    只有当请求经由 HTTPS 到达（或来自 `localhost`）时，会话 cookie 才会带上 `Secure`。
    对局域网地址的纯 HTTP 访问不能带——否则浏览器会直接丢弃这个 cookie——因此服务器会不带
    `Secure` 签发并在日志里告警。此时该网络路径上的任何人都能读到这个会话。除可信局域网外，
    请使用 HTTPS。

## 三条路径对照 {#the-three-paths-side-by-side}

三条路径都到达同一个 `/trpc` API 与同一个工作台，但在**何处**及**如何**认证上不同：

| | 浏览器 + Access | 浏览器 + token 登录 | 桌面（Tauri） |
|---|---|---|---|
| Hostname | 专用 UI hostname，**位于** Cloudflare Access 之后 | 任何能到达该端口的 hostname | 一个**不在** Access 之后的 hostname |
| 登录 | Cloudflare Access 边缘登录（邮箱 / IdP） | 粘贴一次 `clientToken` | 一次性输入 `serverUrl` + `clientToken` |
| 请求上的凭据 | `Cf-Access-Jwt-Assertion`（由边缘签发） | `cortex_ui` 会话 cookie | `x-cortex-token` 头 |
| 何处校验认证 | 服务器校验 JWT | 服务器校验会话 | 服务器校验令牌 |
| `clientToken` 暴露 | **从不接触浏览器** | 输入一次，不在页面中留存 | 存于操作系统密钥链 |
| 能否打开 `/forward` | 否 | 否 | 是 |
| SPA origin | 同源（SPA + `/trpc` 同一主机） | 同源 | 直连 `/trpc`（启用 CORS） |

由于桌面应用发送 `x-cortex-token`，它必须通过一个**不在** Cloudflare Access 之后的
hostname 连接（Access 会在边缘挡住 bearer 请求）。想要原生窗口、需要端口转发、且愿意在本地
存储令牌时，选桌面应用；需要让别人进来、而他们不该看到令牌时，选 Access；只是你自己的浏览器、
且到服务器的通路本就私密时，选 token 登录。

## 故障排查 {#troubleshooting}

**浏览器出现 Cloudflare 登录循环或边缘 `403`**

Access 应用策略未放行你的身份。检查 Cloudflare Zero Trust 面板中该 UI hostname 上
Access 应用的策略。

**浏览器在边缘登录成功，但工作台显示 `401` / 无数据**

边缘已认证你，但服务器拒绝了 JWT。在服务器上确认 `CORTEX_ACCESS_TEAM_DOMAIN` 与你的
team 匹配、`CORTEX_ACCESS_AUD` 与 Access 应用的 AUD 标签完全一致，且设置后已重启守护
进程。若这些未设置，浏览器路径被禁用，每个浏览器请求都是 `401`。

**页面加载但 `/trpc` 调用返回 `404`**

未找到 `web/dist`，因此只提供了 API。构建 SPA（`pnpm --filter web run build`）或将
`CORTEX_UI_SPA_DIR` 指向你构建的产物，然后重启。

**UI hostname 完全不可达**

1. 确认已设置 `CORTEX_UI_HTTP=1` 且添加后已重启守护进程。
2. 在服务器上确认端点已启动：`curl http://127.0.0.1:3004/trpc` 应返回 tRPC 错误
   （而非连接拒绝）。
3. 确认 Cloudflare Tunnel 正在运行且其路由指向正确端口。
