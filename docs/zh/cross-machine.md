# 跨机器操作 {#cross-machine-operation}


Cortex 可以将工作分发到远程机器：运行命令、读写文件、搜索代码以及执行长时间运行的训练作业。这是通过 `cortex-client` 实现的，它是一个轻量级的 WebSocket 守护进程，运行在每个远程机器上并连接回 agent-server。本文档涵盖部署、网络拓扑和安全模型。

## 为什么需要远程客户端 {#why-remote-clients}

运行 LLM 编排、Slack 机器人和调度的 agent-server 进程可能不在具有 GPU 或项目文件的机器上。一个典型的设置：

- `lab2` — agent-server 主机（GPU 训练、仿真、Cortex 守护进程本身）
- `lab` — 局域网上的专用训练机器，有自己的 GPU
- `lab-ksu` — 通过 STCP 隧道访问的远程训练集群
- `my-pc` — 用于 Unity、VR 和文档的 Windows 工作站

每个远程机器运行 `cortex-client`，它连接 agent-server 并代表该机器执行命令。智能体将所有机器视为一个扁平的资源池，并选择每次工具调用目标哪个设备。

## 架构 {#architecture}

完整的服务器端架构（包括六层结构、事件总线和 WebSocket 协议详情）参见 [architecture.md](./architecture.md)。

```
┌─────────────────────────────────┐
│  Agent-Server (lab2)            │
│                                 │
│  client-manager.ts              │
│  ┌───────────────────────────┐  │
│  │ WebSocketServer :3002     │  │
│  │ 设备 Map<name, ws>        │  │
│  │ - lab2 (本地)             │  │
│  │ - lab (远程, SSH)         │  │
│  │ - lab-ksu (远程, STCP)    │  │
│  │ - my-pc (远程, Win/SSH)   │  │
│  └───────────────────────────┘  │
│                                 │
│  MCP core-server                │
│  ┌───────────────────────────┐  │
│  │ remote_bash/read/write    │──┼──→ HTTP :3001 → client-manager → WS → 设备
│  │ remote_edit/glob/grep     │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
         ▲ WebSocket              ▲ SSH
         │ (端口 3002)            │ (端口 22)
┌────────┴────────┐    ┌──────────┴──────────┐
│ cortex-client   │    │ cortex-client        │
│ (lab2, 本地)    │    │ (lab, 远程)          │
│ ws://127.0.0.1  │    │ ws://10.18.108.245   │
└─────────────────┘    └─────────────────────┘
```

每个 `cortex-client` 实例：
- 连接到 agent-server 的 WebSocket 服务器（端口 3002）
- 在连接时以设备名称注册自己（`hello` 消息）
- 每 5 秒发送心跳
- 接收命令消息并在本地机器上执行它们
- 通过同一 WebSocket 连接返回结果

## 安装 cortex-client {#installing-cortex-client}

### 前置条件 {#prerequisites}

- Node.js ≥ 20
- 从远程机器到 agent-server 端口 3002 的网络路径（WebSocket）
- 从 agent-server 到远程机器端口 22 的网络路径（SSH），如果服务器需要远程启动/重启客户端

### 安装 {#installation}

在每台远程机器上：

```bash
npm install -g @cortex-agent/client
```

这会将 `cortex-client` 放到 PATH 上。客户端除 Node.js 外没有运行时依赖——它只使用 Node 内置模块（`fs`、`child_process`、`ws`）。

### 配置 {#configuration}

在远程机器上创建 `~/.cortex/config/cortex-client.json`：

```json
{
  "serverHost": "10.18.108.245",
  "serverPort": 3002,
  "deviceName": "lab"
}
```

- `serverHost` — agent-server 机器的 IP 或主机名，从该远程机器可达
- `serverPort` — WebSocket 端口（默认 3002）
- `serverUrl`（可选）— 客户端拨号的完整 WebSocket URL，优先级高于 `serverHost`/`serverPort`。用于 Cloudflare Tunnel 或任何反向代理路由，例如 `"wss://cortex.example.com"`——这让客户端能连到没有公网 IP 的服务器（见下方 Cloudflare Tunnel）
- `clientToken` — 服务器的 `CORTEX_CLIENT_TOKEN` 共享密钥；没有它 WS 升级会被 `401` 拒绝。服务器通过 SSH 启动客户端时会自动注入，因此仅在手动启动或 systemd 托管的客户端上才需在此设置
- `deviceName` — 此机器的唯一名称，匹配服务器 `machines.json` 中的键

启动客户端：

```bash
cortex-client
```

它在前台运行。对于生产环境，将其包装在进程监督器中（systemd、launchd、tmux、screen）。

## 在服务器上注册机器 {#registering-machines-on-the-server}

机器在 agent-server 主机的 `~/.cortex/config/machines.json` 中注册：

```json
{
  "lab2": {
    "cortexPath": "/home/fangxin/Cortex",
    "gpuCount": 2
  },
  "lab": {
    "cortexPath": "/home/fangxm/Cortex",
    "gpuCount": 1,
    "ssh": "fangxm@10.18.108.245"
  },
  "my-pc": {
    "cortexPath": "D:\\Projects\\Cortex",
    "gpuCount": 0,
    "ssh": "fangxm@rdp.fangxm.me",
    "win": true
  },
  "lab-ksu": {
    "cortexPath": "/home/xinmin",
    "gpuCount": 4,
    "ssh": "xinmin@lab-ksu"
  }
}
```

每个条目：
- `cortexPath`（必需）— 该机器上的工作目录路径
- `gpuCount`（必需）— GPU 数量（非 GPU 机器为 0）
- `ssh`（可选）— SSH 连接的 `user@host`。如果省略，假设机器是本地的，不需要 SSH
- `win`（可选）— 对 Windows 目标设为 `true`（更改 SSH 命令语法）
- `clientCommand`（可选）— 服务器（通过 SSH）启动该机器上 `cortex-client` 所用的命令，默认为裸的 `cortex-client`。当 `cortex-client` 不在该机器**非登录** SSH 的 PATH 上时需要覆盖它——最常见的是 `nvm` 安装：二进制位于 `~/.nvm/...` 下，只有在登录 profile 运行后才出现在 PATH 上。这种情况设为 `"clientCommand": "bash -lc cortex-client"`，让登录 shell 解析出 node 与 `cortex-client`。服务器仍会用其 token 注入及 `nohup`/`echo $!`（Linux）或 `cmd.exe` 包裹的 WMI（Windows）启动机制来包裹这条命令。

文件通过 `fs.watch()` 热重载——更改在几百毫秒内生效，无需重启服务器。

## 网络拓扑 {#network-topology}

从远程客户端到服务器的连接需要到端口 3002 的 TCP 路径。根据网络布局有几种选择。

### 同一局域网 {#same-lan}

最简单的情况。使用服务器的 LAN IP 作为 `serverHost`：

```json
{ "serverHost": "192.168.1.100", "serverPort": 3002, "deviceName": "lab" }
```

如果连接失败，检查服务器的防火墙：

```bash
sudo ufw allow 3002
```

### Tailscale（跨网络推荐） {#tailscale-recommended-for-cross-network}

Tailscale 为每台机器分配一个稳定的 CGNAT IP（`100.x.y.z`），无论物理网络如何。客户端连接到服务器的 Tailscale IP：

```json
{ "serverHost": "100.87.154.62", "serverPort": 3002, "deviceName": "lab-ksu" }
```

查找服务器的 Tailscale IP：

```bash
tailscale ip -4
```

Tailscale 无需端口转发即可穿透 NAT 和防火墙。这是不同网络上机器的推荐选项。

### Cloudflare Tunnel

当服务器和客户端都在 NAT 后、没有公网 IP 时，在服务器上运行 `cloudflared` 把它的 WebSocket 端口通过隧道暴露出去，并用 `serverUrl` 让客户端指向隧道主机名。服务器的 `cloudflared` ingress 把主机名映射到本地 WS 端口：

```yaml
ingress:
  - hostname: cortex.example.com
    service: http://localhost:3002
  - service: http_status:404
```

然后客户端通过 wss/443 拨号连隧道：

```json
{ "serverUrl": "wss://cortex.example.com", "deviceName": "my-pc", "clientToken": "<token>" }
```

两端都是向 Cloudflare 边缘拨出，所以谁都不需要公网 IP 或端口转发，WebSocket 升级也会透明地穿过隧道。

### STCP 隧道 {#stcp-tunnel}

对于在限制性防火墙后即使 Tailscale 也无法建立直接连接的机器，使用 STCP 反向隧道。远程机器将服务器端口转发回自己：

```bash
# 在远程机器上（或通过 SSH）：
ssh -R 3002:localhost:3002 user@lab2
```

然后客户端连接到 `localhost:3002`。这是当前设置中 `lab-ksu` 的连接方式。

### 连接故障排除 {#connection-troubleshooting}

| 症状 | 可能原因 | 修复 |
|---|---|---|
| 客户端无法连接 | 端口 3002 被阻止 | 检查防火墙：`sudo ufw allow 3002` |
| 客户端连接后断开 | NAT 超时 | 使用 Tailscale 或启用 TCP keepalive |
| SSH 可用但 WebSocket 不可用 | SSH 仅打开端口 22 | 打开端口 3002 或使用 Tailscale/反向隧道 |
| Tailscale 已安装但无法连接 | ACL 阻止 | 检查 `tailscale status` 和 ACL 规则 |
| "设备已连接"（代码 4002） | 陈旧连接或重复 | 终止远程机器上的旧客户端进程 |

## WebSocket 协议 {#websocket-protocol}

agent-server 和 cortex-client 之间的协议是纯 WebSocket 上的简单 JSON 消息流。没有 TLS、没有认证令牌、没有共享密钥。安全依赖于网络边界。

### 客户端 → 服务器 {#client-server}

**Hello**（连接时立即发送）：
```json
{ "type": "hello", "device": "lab", "platform": "linux", "capabilities": ["rg"] }
```

**心跳**（每 5 秒）：
```json
{ "type": "heartbeat", "device": "lab", "timestamp": 1716154200000 }
```

**命令结果**（响应服务器命令）：
```json
{ "type": "result", "id": "cmd-abc123", "success": true, "data": { "stdout": "..." } }
```

### 服务器 → 客户端 {#server-client}

**命令**：
```json
{ "type": "command", "id": "cmd-abc123", "action": "bash", "params": { "command": "nvidia-smi" }, "timeout": 120000 }
```

支持的动作：`bash`、`read`、`write`、`edit`、`glob`、`grep`、`cortex-run.launch`、`cortex-run.cancel`。

### 错误代码 {#error-codes}

| 代码 | 含义 |
|---|---|
| 4001 | Hello 中缺少设备名称 |
| 4002 | 设备已连接 |
| 4003 | 心跳超时（15 秒） |

## 服务器端客户端生命周期 {#server-side-client-lifecycle}

agent-server 中的 `client-manager.ts` 模块管理远程客户端生命周期：

1. **启动时** — `startAllRemoteClients()` 遍历 `machines.json` 并在每台机器上生成或通过 SSH 启动 `cortex-client`。对于本地机器（无 `ssh` 字段），直接生成。对于远程机器，运行 `ssh user@host "nohup cortex-client > /dev/null 2>&1 & echo $!"`（Linux）或使用 WMI（Windows）。

2. **心跳监控** — 每 5 秒，服务器检查每个连接的设备是否在最近 15 秒内发送了心跳。错过的心跳触发断开连接和自动重启尝试。

3. **自动重启** — 在断开连接或心跳超时时，服务器在 60 秒延迟后安排重启。它重试直到客户端重新连接。每设备定时器防止重复的重启尝试。

4. **PID 追踪** — 对于通过 SSH 启动的客户端，服务器在 `~/.cortex/data/client-pids.json` 中记录远程 PID，以便在尝试重启前检查进程是否仍然存活。

5. **命令路由** — 当智能体调用 `remote_bash({ device: "lab", ... })` 时，MCP 服务器向 `client-manager` 发送 HTTP 请求，后者在其设备映射中查找 `lab` 的 WebSocket 连接并发送命令。仅在线设备接收命令——如果目标设备离线，工具调用返回错误。

## 客户端重连行为 {#client-side-reconnect-behavior}

`cortex-client` 进程自动处理重连：

- 断开连接时，首次重连尝试前等待 1 秒
- 使用指数退避：1s、2s、4s、8s、16s，上限 30 秒
- 如果服务器以代码 4002（"设备已连接"）拒绝，客户端退出。这防止两个客户端争夺同一设备名称
- 对于所有其他断开连接（网络错误、服务器重启、心跳超时），客户端无限重试

## 远程命令执行 {#remote-command-execution}

来自服务器的每个命令包含 `action` 和 `params`。客户端分发到适当的处理程序：

### bash

在登录 shell 中执行：`/bin/bash -l -c "<command>"`。在 Windows 上，命令通过 git-bash 运行。shell 命令的默认超时为 120 秒（最大 600 秒）。长时间运行的任务使用 `run_in_background: true`，这会生成一个 `cortex-run-watcher` 进程用于停滞检测和回调报告。这些远程执行工具通过 `cortex-core` MCP 服务器暴露给智能体——参见 [mcp.md](./mcp.md)。

### read

使用 `fs.readFileSync()` 从磁盘读取文件。支持图像文件（PNG、JPEG、WebP、GIF、BMP）的可选 `sharp` 调整大小/压缩管道（以保持在令牌预算内），以及 PDF 文件作为嵌入式资源处理。路径必须是绝对路径。

### write 和 edit {#write-and-edit}

`write` 创建或覆盖文件，必要时创建父目录。`edit` 查找并替换已有文件中的字符串。操作成功后返回简短确认；会话活动只记录目标路径和设备，不复制文件内容。

### glob 和 grep {#glob-and-grep}

`glob` 按模式查找文件（如 `**/*.ts`），限于 500 个结果并排除 VCS 目录。`grep` 在可用时使用 `rg`（ripgrep），回退到 `grep -rn`。支持 `head_limit` 和 `offset` 进行分页。

### cortex-run（长时间运行的任务） {#cortex-run-long-running-tasks}

对于训练作业和其他长时间运行的工作，`cortex-run.launch` 生成一个 `cortex-run-watcher` 子进程：
- 监控子进程的停滞（可配置超时，默认 10 分钟无输出）
- 将状态、输出和结果写入 JSON 文件
- 在完成时设置 `callback.pending` 标志
- 主客户端在连接时和每 60 秒刷新挂起的回调

`cortex-run.cancel` 通过 PID 终止被追踪的子进程。

## 检查设备状态 {#checking-device-status}

在智能体会话中，检查哪些设备在线：

```
remote_bash({ device: "lab", command: "hostname" })
```

agent-server 的 Slack 集成也支持 `!devices` 命令，列出所有注册的机器及其在线/离线状态。

从服务器的 CLI：

```bash
# 检查机器注册表
cat ~/.cortex/config/machines.json

# 检查哪些客户端已连接（通过服务器日志）
tail -f ~/.cortex/logs/daemon.log | grep client-manager
```

## 安全边界 {#security-boundary}

远程客户端系统以以下安全约束运行：

- 客户端以启动它的同一用户身份运行——没有权限提升
- WebSocket 协议没有认证。任何可以到达端口 3002 的进程都可以冒充设备。在网络级别保护端口（防火墙、Tailscale ACL 或 localhost 绑定）
- 服务器对远程机器的 SSH 访问由运行 agent-server 的用户的 SSH 密钥控制。智能体不能越权超过该用户的能力
- 针对远程设备的 MCP 工具受 [safety-and-approvals.md](./safety-and-approvals.md) 中记录的相同安全边界规则约束
- `cortex-client` npm 包不安装 postinstall 脚本，不使用 Node.js 内置之外的本地附加组件，除 `ws` 外没有外部依赖

## 多客户端路由 {#multi-client-routing}

没有自动的设备选择。智能体在每个工具调用中通过 `device` 参数显式指定目标设备。智能体从 `machines.json` 注册表（通过上下文注入可见）和工具描述中了解可用设备。

对于 GPU 感知的工作负载（训练），分发系统查询 `gpuCount` 并可以在分配工作前检查 GPU 利用率。任务分发模型参见 [tasks.md](./tasks.md)。

## client-manage 技能 {#the-client-manage-skill}

Cortex 包含一个 `client-manage` 技能（在 cortex-system 插件中），为以下操作提供逐步操作指导：
- 引导新设备（注册、安装、配置、验证、重启）
- 检查在线状态和连接性
- 查看客户端日志
- 更新客户端配置
- 故障排除九种常见症状及其根本原因和修复方法

该技能自动对智能体可用，并作为跨机器管理的操作参考。
