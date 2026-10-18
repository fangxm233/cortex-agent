# 跨机器操作 {#cross-machine-operation}

Cortex 可以把工作分派到远程机器上：运行命令、读写文件、搜索代码，以及执行长时间运行的训练作业。这一切通过 `cortex-client` 完成——它是一个轻量级的 WebSocket 守护进程，运行在每台远程机器上，并主动连回 agent-server。本文档介绍部署方式、网络拓扑和安全模型。

## 为什么需要远程客户端 {#why-remote-clients}

agent-server 进程（负责运行智能体 session、聊天平台和调度）不一定与 GPU 或项目文件在同一台机器上。一个典型的配置：

- `hub` — agent-server 主机（GPU 训练、仿真，以及 Cortex 守护进程本身）
- `trainer` — 局域网内的专用训练机，配有独立 GPU
- `cluster` — 通过隧道访问的远程训练集群
- `desk` — 用于 Unity、VR 和文档工作的 Windows 工作站

每台远程机器都运行 `cortex-client`，它连接到 agent-server，并代表该机器执行命令。在智能体看来，所有机器构成一个扁平的资源池，每次工具调用时自行选择目标设备。

## 架构 {#architecture}

完整的服务器端架构（包括六层结构、事件总线和 WebSocket 协议细节）参见 [architecture.md](./architecture.md)。

```
┌─────────────────────────────────┐
│  Agent-Server (hub)             │
│                                 │
│  client-manager.ts              │
│  ┌───────────────────────────┐  │
│  │ WebSocketServer :3002     │  │
│  │ devices Map<name, ws>     │  │
│  │ - hub (local)             │  │
│  │ - trainer (remote, SSH)   │  │
│  │ - cluster (remote, tunnel)│  │
│  │ - desk (remote, Win/SSH)  │  │
│  └───────────────────────────┘  │
│                                 │
│  MCP core-server                │
│  ┌───────────────────────────┐  │
│  │ remote_bash/read/write    │──┼──→ HTTP :3001 → client-manager → WS → device
│  │ remote_edit/glob/grep     │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
         ▲ WebSocket              ▲ SSH
         │ (port 3002)            │ (port 22)
┌────────┴────────┐    ┌──────────┴──────────┐
│ cortex-client   │    │ cortex-client        │
│ (hub, local)    │    │ (trainer, remote)    │
│ ws://127.0.0.1  │    │ ws://192.0.2.10      │
└─────────────────┘    └─────────────────────┘
```

每个 `cortex-client` 实例：
- 连接 agent-server 的 WebSocket 服务器（端口 3002），并出示 `CORTEX_CLIENT_TOKEN`
- 连接时以设备名注册自己（`hello` 消息）
- 每 5 秒发送一次心跳
- 接收命令消息并在本机执行
- 通过同一条 WebSocket 连接返回结果；文件传输和端口转发则另开独立的回连 socket

## 安装 cortex-client {#installing-cortex-client}

### 前置条件 {#prerequisites}

- Node.js ≥ 20
- 从远程机器直连 agent-server 的 WebSocket 路径，或者从 agent-server 到远程机器的 SSH 路径（用于托管的反向路由），二者满足其一
- 如果服务器需要远程启动/重启客户端，还需要从 agent-server 到远程机器 22 端口（SSH）的网络路径

### 安装 {#installation}

客户端以一个自包含的 bundle——`client.mjs`——分发，按托管布局存放在每台设备上。另有一个 `cortex-run-watcher.mjs` 作为空的兼容占位文件随之下发：更新包在两端都按文件名校验，如果不带上它，在 `cortex-run` 移除之前安装的客户端会拒绝此后的每一次更新。

```
~/.cortex/client/
├── current/    # the running version (client.mjs + a compatibility stub)
└── previous/   # the prior version, kept for manual rollback
```

新的本地桌面安装会在 init 期间显式请求准备客户端。服务器包中携带由同一份源码构建出的两个客户端文件；init 把它们准备到 `<CORTEX_HOME>/client/current/` 下，并创建本机客户端配置。服务器在 `client/local-install.json` 中记录所有权，并在启动自己的客户端时恢复被中断的准备过程。已有的、没有所有权记录的客户端文件或用户手动修改过的配置不会被接管。普通 init 和远程连接不会请求这项准备。本机客户端使用服务器的 Node 和所选环境，loopback WebSocket URL 与 token 在启动时注入。仅重新打开 App 会保留正在运行的守护进程；客户端的恢复由服务器启动流程负责。

远程设备上不通过 npm 安装任何东西，唯一的要求是 Node.js。服务器的 bootstrap 脚本负责安装远程设备上的文件——它检查 SSH 和 Node.js，把 bundle 传到 `~/.cortex/client/current/`，并写入包含 `serverHost`、`serverPort` 和 `deviceName` 的客户端配置。它不会启动客户端，也不会在设备侧创建服务。该脚本在源码 checkout 的 `agent-server/` 目录下运行，面向 Linux 和 macOS 设备，接受 `--host`、`--device-name` 和 `--server-host`（均为必填）以及 `--server-port`（默认 3002）：

```bash
node --import tsx src/domain/remote/client-bootstrap.ts \
  --host user@machine --device-name trainer --server-host 192.0.2.10
```

如果设备改为拨号 `serverUrl`，在 bootstrap 之后编辑 `cortex-client.json` 即可。

当设备上的托管安装损坏或被清空时，bootstrap 也是救援手段。先在服务器的 `machines.json` 中注册该设备，运行 bootstrap，然后启动或重启 agent-server。客户端的启动与恢复由服务器负责；不要在客户端设备上创建 systemd、launchd、计划任务、tmux 或 screen 自启动项。

### 配置 {#configuration}

在远程机器上创建 `~/.cortex/config/cortex-client.json`：

```json
{
  "serverHost": "192.0.2.10",
  "serverPort": 3002,
  "deviceName": "trainer"
}
```

- `serverHost` — agent-server 机器的 IP 或主机名，需从这台远程机器可达
- `serverPort` — WebSocket 端口（默认 3002）
- `serverUrl` —（可选）客户端拨号使用的完整 WebSocket URL，优先级高于 `serverHost`/`serverPort`。用于 Cloudflare Tunnel 或任何经反向代理的路由，例如 `"wss://cortex.example.com"`——这样客户端就能连上没有公网 IP 的服务器（见下文 Cloudflare Tunnel）
- `clientToken` — 服务器的 `CORTEX_CLIENT_TOKEN` 共享密钥；缺少它时 WS 升级会被 `401` 拒绝。服务器启动客户端时会自动注入，因此只有临时手动启动的诊断进程才需要在这里设置
- `deviceName` — 本机的唯一名称，需与服务器 `machines.json` 中的键一致。默认为本机主机名

环境变量 `CORTEX_SERVER_URL` 和 `CORTEX_CLIENT_TOKEN` 一旦设置，优先级高于 `serverUrl` 和 `clientToken`。客户端的配置、安装和日志目录遵循 `CORTEX_HOME`，日志写入 `~/.cortex/logs/client-YYYYMMDD.log`，保留 14 天。

诊断时，可以在环境中提供 token，以前台方式运行 `cortex-client`。生产环境的客户端由 agent-server 启动和监督；在设备侧再配置一个监督进程会产生相互竞争的生命周期管理者，因此不得这样配置。

## 在服务器上注册机器 {#registering-machines-on-the-server}

机器注册在 agent-server 主机的 `~/.cortex/config/machines.json` 中：

```json
{
  "hub": {
    "cortexPath": "/home/user/Cortex",
    "gpuCount": 2
  },
  "trainer": {
    "cortexPath": "/home/user/Cortex",
    "gpuCount": 1,
    "ssh": "user@192.0.2.10"
  },
  "desk": {
    "cortexPath": "D:\\Projects\\Cortex",
    "gpuCount": 0,
    "ssh": "user@desk.example.com",
    "win": true
  },
  "cluster": {
    "cortexPath": "/home/user",
    "gpuCount": 4,
    "ssh": "user@cluster.example.com"
  }
}
```

每个条目：
- `cortexPath`（必填）— 该机器上的工作目录路径
- `gpuCount`（必填）— GPU 数量（无 GPU 的机器填 0）。每个客户端连接时会用 `nvidia-smi` 探测本机并上报数量；服务器发现数值不一致时会直接写回本文件，因此过期的数字会在下次连接时自动纠正。无法运行 `nvidia-smi` 的机器不上报，保留你在这里填写的值。
- `ssh`（可选）— SSH 连接用的 `user@host`。省略时视为本地机器，不需要 SSH
- `win`（可选）— Windows 目标设为 `true`（会改变 SSH 命令语法）
- `clientCommand`（可选）— 服务器（通过 SSH）在该机器上启动客户端所用的命令。默认为 `node "$HOME/.cortex/client/current/client.mjs"`（Linux）或 `node "%USERPROFILE%\.cortex\client\current\client.mjs"`（Windows）。当 `node` 不在该机器**非登录** SSH 的 PATH 上时需要覆盖它——最常见的是 `nvm` 安装，node 位于 `~/.nvm/...` 下；这时写绝对 node 路径，例如 `"/home/u/.nvm/versions/node/v20.19.5/bin/node /home/u/.cortex/client/current/client.mjs"`。服务器会用自己的 token 注入以及 `nohup`/`echo $!`（Linux）或 `cmd.exe` 包裹的 WMI（Windows）启动机制来包裹这条命令。

`clientConnection` 用于选择路由。默认值 `direct` 使用 `cortex-client.json` 中的 URL。设为 `ssh-reverse` 时，服务器会维护一条 SSH 反向隧道，并在启动客户端时注入 loopback WebSocket URL。`clientReversePort` 可选，用于指定远程机器上的 loopback 端口；它只在 `ssh-reverse` 下有效，默认等于服务器的客户端端口，取值必须在 1024 到 65535 之间。SSH 反向路由要求配置 `ssh`。

`machines.json` 无效时，服务器在启动阶段就会停止。服务器运行期间所做的修改若未通过校验，服务器会保留先前的注册表，并发送一条管理员通知。该文件通过 `fs.watch()` 监视，普通的注册表读取方会在几百毫秒内看到更新。托管客户端的路由字段在客户端启动开始时生成快照，因此修改 `clientConnection`、`clientReversePort` 或对应的 `ssh` 目标需要重启服务器。删除条目在同一次重载中生效：服务器会停止该机器的 SSH 反向隧道，并取消其待执行的客户端重启。`cortex client remove --device <name>` 会删除条目，同时停止并卸载该机器上的客户端（参见 [CLI 参考](./cli-reference.md)）。

## 网络拓扑 {#network-topology}

远程客户端到服务器的连接需要一条通往 3002 端口的 TCP 路径。根据网络布局，有以下几种选择。

### 同一局域网 {#same-lan}

最简单的情况。把服务器的局域网 IP 作为 `serverHost`：

```json
{ "serverHost": "192.168.1.100", "serverPort": 3002, "deviceName": "trainer" }
```

如果连接失败，检查服务器的防火墙：

```bash
sudo ufw allow 3002
```

### Tailscale（跨网络推荐） {#tailscale-recommended-for-cross-network}

无论物理网络如何，Tailscale 都会为每台机器分配一个稳定的 CGNAT IP（`100.x.y.z`）。客户端连接服务器的 Tailscale IP：

```json
{ "serverHost": "100.64.12.34", "serverPort": 3002, "deviceName": "cluster" }
```

查询服务器的 Tailscale IP：

```bash
tailscale ip -4
```

Tailscale 无需端口转发即可穿透 NAT 和防火墙，是位于不同网络的机器的推荐方案。

### Cloudflare Tunnel {#cloudflare-tunnel}

当服务器和客户端都位于 NAT 之后、没有公网 IP 时，在服务器上运行 `cloudflared`，通过隧道暴露其 WebSocket 端口，再用 `serverUrl` 让客户端指向隧道主机名。服务器的 `cloudflared` ingress 把主机名映射到本地 WS 端口：

```yaml
ingress:
  - hostname: cortex.example.com
    service: http://localhost:3002
  - service: http_status:404
```

然后客户端经 wss/443 拨号连接隧道：

```json
{ "serverUrl": "wss://cortex.example.com", "deviceName": "desk", "clientToken": "<token>" }
```

两端都是向 Cloudflare 边缘发起出站连接，所以双方都不需要公网 IP 或端口转发，WebSocket 升级也会透明地穿过隧道。

### 托管 SSH 反向路由 {#managed-ssh-reverse-route}

当服务器能够 SSH 登录远程机器时，Cortex 可以通过一条持久的反向转发把客户端 WebSocket 传回来。在服务器上这样配置该机器：

```json
{
  "worker": {
    "cortexPath": "/srv/workspace",
    "gpuCount": 1,
    "ssh": "user@worker",
    "clientConnection": "ssh-reverse",
    "clientReversePort": 13002
  }
}
```

服务器会监督一条到 `user@worker` 的 OpenSSH master 连接，承载 `-R 127.0.0.1:13002:127.0.0.1:3002`，并设置 `ExitOnForwardFailure=yes` 和 15 秒 keepalive。每次启动前，它会先释放早先隧道遗留在远程端口上的陈旧 listener，然后等待 SSH control socket 就绪，再以 `CORTEX_SERVER_URL=ws://127.0.0.1:13002` 启动客户端。远程 listener 只绑定 loopback。隧道故障有独立的重试循环，退避时间从 1 秒到 30 秒，客户端则保持常规的 WebSocket 重连行为。在 SSH 隧道内仍然必须提供 token。control socket 存放在 `$CORTEX_HOME/data/client-ssh-tunnels/` 下，每个客户端启动时所用的路由记录在 `$CORTEX_HOME/data/client-routes.json` 中，因此仍运行在与当前配置不符的路由上的客户端会被停止并重新启动。

如果默认端口在远程机器上已被占用，可以改用其他 `clientReversePort`。`~/.ssh/config` 中的 SSH alias 和 `ProxyCommand` 条目可以直接使用，因为配置的 `ssh` 值会作为单个 OpenSSH host 参数传入。

### 外部托管的反向隧道 {#externally-managed-reverse-tunnel}

由其他进程单独监督的 SSH 隧道也能提供同样的网络路径：

```bash
ssh -N -R 127.0.0.1:3002:127.0.0.1:3002 user@server
```

这种方式下，把客户端配置为 `"serverUrl": "ws://127.0.0.1:3002"`，并让 `clientConnection` 保持 `direct`，因为隧道进程不归 Cortex 管理。

### 连接故障排查 {#connection-troubleshooting}

| 症状 | 可能原因 | 解决方法 |
|---|---|---|
| 客户端无法连接 | 3002 端口被阻断 | 检查防火墙：`sudo ufw allow 3002` |
| 客户端连上后又断开 | NAT 超时 | 使用 Tailscale 或启用 TCP keepalive |
| SSH 可用但 WebSocket 不可用 | 只开放了 22 端口 | 开放 3002 端口，或使用 Tailscale/反向隧道 |
| 已安装 Tailscale 但无法连接 | ACL 阻断 | 检查 `tailscale status` 和 ACL 规则 |
| "Device already connected"（代码 4002） | 陈旧连接或重复客户端 | 终止远程机器上的旧客户端进程 |
| "Unknown device"（代码 4005） | `deviceName` 不在 `machines.json` 中 | 添加该机器，或修正 `deviceName` |
| 连接时返回 HTTP 401 | `CORTEX_CLIENT_TOKEN` 缺失或错误 | 让服务器来启动客户端，或从服务器的 `config/.env` 复制 token |

客户端自己的日志——设备上的 `~/.cortex/logs/client-YYYYMMDD.log`——会记录每次连接尝试及其 close code。

## WebSocket 协议 {#websocket-protocol}

agent-server 与 cortex-client 之间的协议是 WebSocket 上的 JSON 消息流。每次 HTTP upgrade 都必须在 `x-cortex-token` header 中携带共享的 `CORTEX_CLIENT_TOKEN`；token 缺失或不匹配时会以 HTTP 401 拒绝。TLS 取决于所选路由：`wss://` endpoint 提供 TLS，而直接 loopback 和 SSH 反向路由则在各自受保护的传输通道内使用 `ws://`。

### 客户端 → 服务器 {#client-server}

**Hello**（连接后立即发送）。`bundleHash` 标识客户端正在运行的 bundle（按顺序对各 bundle 文件计算 sha256）；服务器把它与期望的 bundle 比较，以决定是否推送更新。`gpuCount` 是客户端自己用 `nvidia-smi` 得到的数量，无法探测时为 `null`；`pid` 是客户端的进程 ID，服务器会为运行在其本机上的客户端记录它：
```json
{ "type": "hello", "device": "trainer", "platform": "linux", "capabilities": ["file-stream", "rg"], "gpuCount": 1, "bundleHash": "cebdfcd6…", "pid": 41822 }
```

**Heartbeat**（每 5 秒）：
```json
{ "type": "heartbeat", "device": "trainer", "timestamp": 1716154200000 }
```

**Command result**（响应服务器命令；`success` 为 false 时用 `error` 代替 `data`）：
```json
{ "type": "result", "commandId": "cmd-abc123", "success": true, "data": { "stdout": "..." } }
```

**Update result**（响应服务器的 `update` 推送）：
```json
{ "type": "update-result", "device": "trainer", "hash": "cebdfcd6…", "ok": true }
```

### 服务器 → 客户端 {#server-client}

**Command**：
```json
{ "type": "command", "commandId": "cmd-abc123", "action": "bash", "params": { "command": "nvidia-smi", "timeout": 120000 } }
```

支持的 action：`bash`、`read`、`write`、`edit`、`glob`、`grep`、`file.stat`。bash 的时间限制以毫秒为单位放在 `params.timeout` 中。服务器为每条命令维护自己的计时器——调用自带限制时用该限制，否则 bash 为 120 秒、文件类 action 为 30 秒——超时仍未收到结果就判定调用失败。

**Open stream**（端口转发：客户端回连，把一条原始 TCP 连接接到设备上的某个 loopback 端口；参见[端口转发](#port-forwarding)）：
```json
{ "type": "open-stream", "streamId": "4be1…", "host": "127.0.0.1", "port": 6006 }
```

**Open file stream**（服务器需要从设备上取回整个文件时发送，例如 `send_file device="trainer"`）。与 `open-stream` 一样，它通过一条新的出站 socket 应答，而不走这条连接，因此大文件传输既不会阻塞命令，也不必 base64 编码后挤进控制通道：
```json
{ "type": "open-file-stream", "streamId": "9f3c…", "path": "/home/x/report.csv" }
```

**Update**（当设备 hello 上报的 bundle 与期望不一致时推送；`files` 以 base64 携带完整 artifact）：
```json
{ "type": "update", "updateId": "a1b2c3", "version": "2026.7.30-dev", "hash": "cebdfcd6…", "files": [ { "name": "client.mjs", "data": "…" }, { "name": "cortex-run-watcher.mjs", "data": "…" } ] }
```

### 错误代码 {#error-codes}

| 代码 | 含义 |
|---|---|
| 4001 | hello 中缺少设备名 |
| 4002 | 设备已连接 |
| 4003 | 心跳超时（15 秒） |
| 4004 | 未知 stream：回连 socket 指定了服务器并未预期的 stream |
| 4005 | 未知设备：hello 中的名称未在 `machines.json` 中注册 |
| 1001 | 服务器正在关闭 |

## 服务器端客户端生命周期 {#server-side-client-lifecycle}

agent-server `domain/remote/` 下的两个模块共同负责远程客户端的生命周期：`client-manager.ts` 持有设备连接（心跳和命令路由），`client-lifecycle.ts` 负责启动、跟踪和重启客户端：

1. **启动时** — `startAllRemoteClients()` 遍历 `machines.json`，在每台机器上直接 spawn 或经 SSH 启动客户端。对于本地机器（无 `ssh` 字段），直接 spawn `node ~/.cortex/client/current/client.mjs`。对于远程机器，通过 SSH 以 `nohup`/`echo $!`（Linux）或 WMI（Windows）运行启动命令。`ssh-reverse` 机器会先建立一条受监督的反向隧道；首次启动和自动重启共用同一个感知路由的 launcher 和远程 PID 跟踪。如果启动命令已返回 PID，但客户端尚未发送 `hello`，服务器会让该设备的恢复计时器保持就绪，直到连接到来。

2. **心跳监控** — 服务器每 5 秒检查一次，确认每个已连接设备在最近 15 秒内发送过心跳。错过心跳会触发断开连接并尝试自动重启。

3. **自动重启** — 首次启动后、断开连接或心跳超时后，离线设备会在 60 秒延迟后再次尝试启动。服务器会一直重试，直到客户端连上。每台设备各有一个计时器，防止重复发起重启。

4. **PID 跟踪** — 服务器把每个已启动客户端的 PID（无论本地还是远程）记录在 `~/.cortex/data/client-pids.json` 中，以便在尝试重启前检查进程是否仍然存活。

5. **命令路由** — 当智能体调用 `remote_bash({ device: "trainer", ... })` 时，MCP 服务器向 `client-manager` 发送 HTTP 请求，后者在设备映射中查找 `trainer` 的 WebSocket 连接并下发命令。只有在线设备才会收到命令——目标设备离线时，工具调用返回错误。

## 客户端更新 {#client-updates}

客户端自行更新；服务器负责发布期望的 bundle。对于由 App 登记的本机客户端，bundle 来自已安装的服务器包，并校验其按序计算的文件 hash；payload 缺失或无效时不会回退到 npm。对于其他客户端，从源码 checkout 运行的服务器（设置了 `CORTEX_REPO` 或 `CORTEX_CLIENT_REPO`）会用 esbuild 构建 client 仓库，已安装的服务器则从 npm 拉取最新发布的 `@cortex-agent/client`，按版本缓存在 `$CORTEX_HOME/data/client-bundles/` 下。每个设备的 hello 都携带客户端自己的 bundle hash；与期望 hash 不一致时，服务器通过已有的 WebSocket 推送一条携带完整 artifact 的 `update` 消息。安装成功和失败都会以聊天通知的形式告知。在 `settings.json` 中把 `clientHotReloadEnabled` 设为 `false` 会关闭更新推送，此时已有的本机客户端版本在准备过程中会被保留，而不是被替换。

客户端把文件写入 `~/.cortex/client/next/`，校验 hash，把 `current/` 轮换为 `previous/`、`next/` 轮换为 `current/`，回报 `update-result`，关闭 socket，从 `current/` 启动后继进程，然后退出。后继进程带着新 hash 重连，服务器将其记录为收敛完成。任何失败（hash 不符、磁盘不可写）都不会触动正在运行的版本——设备继续以旧 bundle 在线，服务器也会收到失败原因。同一设备上安装失败后，10 分钟内不会重试；正在推送或刚刚安装完成的推送在 2 分钟内不会重复。

由于触发点就是 hello 本身，设备在任何一次连接时都会收敛：服务器带着新构建重启之后、设备离线数日后重新上线时，或者刚做完 bootstrap 时。不存在定时更新任务。如果新 bundle 一启动就崩溃，SSH 监督会不断重新拉起 `current/`。手动恢复时，先把故障版本挪开，再在设备上恢复 `previous/`，或者重新执行一次 bootstrap。这些路径是真实目录，不是符号链接：把 `previous/` 移到原位之前，`current/` 必须不存在。下面的命令把故障版本保留在 `broken/` 中，并要求这个名称尚未被占用；如有需要，换一个未使用的名称。如果客户端安装根目录不是 `~/.cortex/client`，请换成实际路径。

Linux/macOS（Bash）：

```bash
cd ~/.cortex/client &&
  test -d previous && test ! -e broken &&
  mv current broken && mv previous current
```

Windows（PowerShell）：

```powershell
& {
  Set-Location "$HOME/.cortex/client" -ErrorAction Stop
  if (-not (Test-Path -LiteralPath previous -PathType Container)) { throw 'previous/ is missing' }
  if (Test-Path -LiteralPath broken) { throw 'Choose an unused backup name for broken/' }
  Move-Item -LiteralPath current -Destination broken -ErrorAction Stop
  Move-Item -LiteralPath previous -Destination current -ErrorAction Stop
}
```

## 客户端重连行为 {#client-side-reconnect-behavior}

`cortex-client` 进程会自动处理重连：

- 断开后，等待 1 秒再进行首次重连
- 采用指数退避：1s、2s、4s、8s、16s，上限 30 秒
- 如果服务器以代码 4002（"Device already connected"）拒绝，客户端退出。这可以防止两个客户端争抢同一个设备名
- 如果服务器以代码 4005（"Unknown device"）拒绝，客户端退出。它的 `deviceName` 必须与 `machines.json` 中的某个条目一致，条目中没有 `ssh` 字段的本机客户端也不例外
- 对于其他所有断开情况（网络错误、服务器重启、心跳超时），客户端会无限重试

## 远程命令执行 {#remote-command-execution}

服务器发来的每条命令都包含 `action` 和 `params`，客户端将其分发给相应的处理程序：

### bash {#bash}

在登录 shell 中执行：`/bin/bash -l -c "<command>"`。在 Windows 上，命令通过 Git Bash 运行：设置了 `CORTEX_GIT_BASH_PATH` 时使用该路径，否则依次查找 Program Files 下的标准位置和 `PATH`。`timeout` 参数取 1 到 600 的整数秒，默认 120。前台命令超时会返回退出码 124，并在 POSIX 上终止命令所在的进程组、在 Windows 上终止其进程树。stdout 超过 200 KB 或 stderr 超过 50 KB 时，输出只保留首尾部分。`run_in_background: true` 会立即返回 detached shell 的 PID，并忽略 `timeout`。Cortex 不监督长时间运行的任务：请自己启动它，并让它通过 [waitpoint](./waitpoints.md) 回报。这些远程执行工具通过 `cortex-core` MCP 服务器暴露给智能体——参见 [mcp.md](./mcp.md)。

### read {#read}

从磁盘读取文件。路径必须是绝对路径，超过 10 MB 的文件会被拒绝。文本带行号返回，默认 2,000 行；请求范围超过约 25,000 词时会被拒绝，并给出建议的 `limit`。图片文件（PNG、JPEG、WebP、GIF、BMP）和 PDF 以 base64 整体返回；如果 `sharp` 可用，服务器的 `remote_read` 工具会对大图做缩小处理。

### file.stat {#filestat}

元数据探测——大小、文件名、mtime——在文件传输之前执行，这样路径错误或文件过大时会给出真实的错误信息，而不是传到一半中断。路径必须是绝对路径。

### 把设备上的文件发到聊天 {#sending-a-devices-file-to-the-chat}

`send_file`（以及 `slack_send_file` / `feishu_send_file`）接受一个可选的 `device` 参数。带上它时，路径会在该设备上读取，字节经反向通道流回服务器，再作为普通附件发送：

```js
send_file({ device: "trainer", file_path: "/home/x/runs/loss.png", caption: "latest curve" })
send_file({ device: "trainer", files: [{ file_path: "/home/x/runs/loss.png" }, { file_path: "/home/x/runs/eval.csv" }] })
```

如果设备离线、路径不是可读文件，或文件超过 200 MB 上限，服务器会在传输任何内容之前就拒绝；传输提前结束时也会判定失败，而不是交付一个被截断的文件。运行早于该功能的客户端版本的设备不会上报 `file-stream` 能力，会收到说明这一点的拒绝消息；它们在下一次[客户端更新](#client-updates)后获得该能力。

### write 和 edit {#write-and-edit}

`write` 创建或覆盖文件，必要时创建父目录。`edit` 在已有文件中查找并替换字符串。修改成功后返回一条简短的确认；session 活动只记录目标路径和设备，不复制文件内容。

### glob 和 grep {#glob-and-grep}

`glob` 按模式查找文件（例如 `**/*.ts`），最多返回 500 个结果，并排除 VCS 目录、`node_modules`、`__pycache__`、`.tox` 和 `.mypy_cache`。`grep` 在可用时使用 `rg`（ripgrep），通过 `head_limit`（默认 250）和 `offset` 分页。未安装 `rg` 时回退到 `grep -rn`，此时会忽略分页、glob、type 和上下文选项。

### 远程 AGENTS.md 文件 {#remote-agentsmd-files}

执行 `read`、`write` 和 `edit` 时，客户端还会从目标文件所在位置逐级向上查找，返回沿途找到的 `AGENTS.md` 和 `AGENTS.local.md` 文件（最多 20 级，每个文件最大 200 KB），外加设备上 `~/.cortex/AGENTS.md` 处的那一个。`remote_read`、`remote_write` 和 `remote_edit` 工具会把这些文件逐一加入结果，每个 session 只加一次。这样，放在设备上项目旁的指令也能像本地指令一样到达智能体。

### 端口转发 {#port-forwarding}

服务器可以把设备上的某个 loopback 端口映射到自己机器上的 loopback 端口（同时最多 32 个）：每当有连接打到服务器侧端口，服务器就发送 `open-stream`，客户端随即回连，把字节转发到设备上的 `127.0.0.1:<port>`。有两项功能用到它：

- **设备上的浏览器。** 输入框的浏览器选择器会列出本机和每台已连接的设备。选择某台设备后，会在该设备上启动 Chrome，并通过转发的调试端口把 session 的浏览器工具接上去。该浏览器由在这台设备上运行的各个 turn 共享，空闲 10 分钟后关闭。
- **停靠浏览器的端口面板**会列出服务器或已连接设备上正在监听的端口，并在桌面 App 中预览；远程端口会先完成转发。

### 长时间运行的任务 {#long-running-jobs}

Cortex 不在设备上启动、监督或接管任何进程。按你平常的方式启动任务（`nohup`、`setsid`、tmux、某个调度器），再登记一个 [waitpoint](./waitpoints.md)，任务结束时 session 就会被唤醒。在设备上，任务只需往 `~/.cortex/tmp/signals/` 中写入一个小 JSON 文件。服务器每轮扫描时，会通过这个客户端已经保持着的连接，用普通的 `bash` 命令列出、读取并删除这些文件——仅限有已登记 waitpoint 的设备——因此设备上不需要额外安装任何东西。

## 检查设备状态 {#checking-device-status}

智能体可以在其远程工具的描述中看到已注册的设备；调用离线设备会失败，并返回当前在线的设备列表。快速探测一下：

```
remote_bash({ device: "trainer", command: "hostname" })
```

在 Web UI 和桌面 App 中，顶栏的机器按钮显示在线机器数量，点开后会弹出一个面板，列出每台机器的 GPU、进程、负载、内存、磁盘和运行时长，这些信息按需通过客户端执行一条 shell 命令探测得到。在 Slack 或飞书中，`!devices`（别名 `!clients`）会列出已注册和已连接的机器，以及它们的平台、连接时长和最近一次心跳。

在服务器的命令行中：

```bash
# Check machine registry
cat ~/.cortex/config/machines.json

# Check which clients are connected (via the server logs)
tail -f ~/.cortex/logs/daemon.log | grep client-manager
```

## 安全边界 {#security-boundary}

远程客户端系统遵循以下安全约束：

- 客户端以启动它的同一用户身份运行——不提升权限
- 每次客户端 WebSocket upgrade 都必须携带 `CORTEX_CLIENT_TOKEN`。防火墙、Tailscale ACL、localhost 绑定或 SSH 反向路由等网络控制仍作为纵深防御
- 服务器对远程机器的 SSH 访问取决于运行 agent-server 的用户的 SSH 密钥。智能体的能力不会超出该用户的权限
- 面向远程设备的 MCP 工具同样受 [safety-and-approvals.md](./safety-and-approvals.md) 中记录的安全边界规则约束
- `cortex-client` npm 包不安装 postinstall 脚本，除 Node.js 自带的之外不使用原生扩展，除 `ws` 外没有外部依赖
- 端口转发在服务器上只绑定 loopback，在设备上也只能到达 loopback 端口

## 多客户端路由 {#multi-client-routing}

没有自动的设备选择。智能体在每次工具调用中通过 `device` 参数显式指定目标设备。它从远程工具描述中的设备目录了解有哪些可用设备，该目录由 `machines.json` 生成，并标出了 Windows 机器。

对于需要 GPU 的工作负载（训练），智能体可以从注册表读取每台机器的 `gpuCount`，并在决定在哪里运行之前检查设备上的 GPU 利用率。

## client-manage 技能 {#the-client-manage-skill}

Cortex 包含一个 `client-manage` 技能（位于 cortex-system 插件中），为以下操作提供分步操作指导：
- 引导新设备（注册、安装、配置、验证、重启）
- 检查在线状态和连通性
- 查看客户端日志
- 更新客户端配置
- 排查常见症状，给出根本原因和修复方法

该技能自动对智能体可用，是跨机器管理的操作参考。
