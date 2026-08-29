# Cross-Machine Operation

Cortex can dispatch work to remote machines: run commands, read and write
files, search code, and execute long-running training jobs. This is done
through `cortex-client`, a lightweight WebSocket daemon that runs on each
remote machine and connects back to the agent-server. This document covers
deployment, the network topology, and the security model.

## Why remote clients

The agent-server process (which runs the LLM orchestration, Slack bot, and
scheduling) may not be on the machine with the GPUs or the project files. A
typical setup:

- `lab2` — the agent-server host (GPU training, simulation, the Cortex
  daemon itself)
- `lab` — a dedicated training box on the LAN with its own GPU
- `lab-ksu` — a remote training cluster accessed via an STCP tunnel
- `my-pc` — a Windows workstation for Unity, VR, and documentation

Each remote machine runs `cortex-client`, which connects to the agent-server
and executes commands on that machine's behalf. The agent sees all machines as
a flat pool and selects which device to target per tool call.

## Architecture

For the full server-side architecture including the six-layer structure,
event bus, and WebSocket protocol details, see [architecture.md](./architecture.md).

```
┌─────────────────────────────────┐
│  Agent-Server (lab2)            │
│                                 │
│  client-manager.ts              │
│  ┌───────────────────────────┐  │
│  │ WebSocketServer :3002     │  │
│  │ devices Map<name, ws>     │  │
│  │ - lab2 (local)            │  │
│  │ - lab (remote, SSH)       │  │
│  │ - lab-ksu (remote, STCP)  │  │
│  │ - my-pc (remote, Win/SSH) │  │
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
│ (lab2, local)   │    │ (lab, remote)        │
│ ws://127.0.0.1  │    │ ws://10.18.108.245   │
└─────────────────┘    └─────────────────────┘
```

Each `cortex-client` instance:
- Connects to the agent-server's WebSocket server (port 3002)
- Registers itself with a device name on connect (`hello` message)
- Sends a heartbeat every 5 seconds
- Receives command messages and executes them on the local machine
- Returns results over the same WebSocket connection

## Installing cortex-client

### Prerequisites

- Node.js ≥ 20
- Either a direct WebSocket path from the remote machine to the agent-server,
  or an SSH path from the agent-server to the remote machine for a managed
  reverse route
- Network path from the agent-server to the remote machine on port 22 (SSH),
  if the server needs to start/restart the client remotely

### Installation

The client ships as two self-contained bundles — `client.mjs` (the daemon) and
`cortex-run-watcher.mjs` (the long-running-job watchdog) — that live on each
device under the managed layout:

```
~/.cortex/client/
├── current/    # the running version (client.mjs + cortex-run-watcher.mjs)
└── previous/   # the prior version, kept for manual rollback
```

Nothing is installed through npm on the device; the only requirement is Node.js.
The server's bootstrap CLI installs the device files — it checks SSH and Node.js,
ships the bundle into `~/.cortex/client/current/`, and writes the client config.
It does not start the client or create a device-side service:

```bash
node --import tsx src/domain/remote/client-bootstrap.ts \
  --host user@machine --device-name lab --server-host 10.18.108.245
```

Bootstrap is also the rescue path when a device's managed install is broken
or wiped. Register the device in the server's `machines.json`, run bootstrap,
then start or restart the agent-server. The server owns client startup and
recovery; do not create a systemd, launchd, scheduled-task, tmux, or screen
autostart entry on the client device.

### Configuration

Create `~/.cortex/config/cortex-client.json` on the remote machine:

```json
{
  "serverHost": "10.18.108.245",
  "serverPort": 3002,
  "deviceName": "lab"
}
```

- `serverHost` — the IP or hostname of the agent-server machine, reachable
  from this remote machine
- `serverPort` — the WebSocket port (default 3002)
- `serverUrl` — (optional) a full WebSocket URL the client dials, taking
  precedence over `serverHost`/`serverPort`. Use it for a Cloudflare Tunnel or
  any reverse-proxied route, e.g. `"wss://cortex.example.com"` — this lets a
  client reach a server that has no public IP (see Cloudflare Tunnel below)
- `clientToken` — the server's `CORTEX_CLIENT_TOKEN` shared secret; the WS
  upgrade is rejected with `401` without it. The server injects this
  automatically when it launches the client, so set it here only for a
  temporary hand-started diagnostic process
- `deviceName` — a unique name for this machine, matching the key in the
  server's `machines.json`

For diagnostics, `cortex-client` can be run in the foreground with the token in
its environment. Production clients are started and supervised by the
agent-server; a second device-side supervisor creates competing lifecycle
owners and must not be configured.

## Registering machines on the server

Machines are registered in `~/.cortex/config/machines.json` on the agent-server
host:

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

Each entry:
- `cortexPath` (required) — the working directory path on that machine
- `gpuCount` (required) — number of GPUs (0 for non-GPU machines)
- `ssh` (optional) — `user@host` for SSH connections. If omitted, the machine
  is assumed to be local and no SSH is needed
- `win` (optional) — set to `true` for Windows targets (changes the SSH
  command syntax)
- `clientCommand` (optional) — the command the server runs (over SSH) to launch
  the client on this machine. Defaults to
  `node "$HOME/.cortex/client/current/client.mjs"` (Linux) or
  `node "%USERPROFILE%\.cortex\client\current\client.mjs"` (Windows). Override it
  when `node` isn't on the machine's non-login SSH PATH — most commonly an `nvm`
  install, where node lives under `~/.nvm/...`; set an absolute node path, e.g.
  `"/home/u/.nvm/versions/node/v20.19.5/bin/node /home/u/.cortex/client/current/client.mjs"`.
  The server wraps this command with its token injection and the
  `nohup`/`echo $!` (Linux) or `cmd.exe`-wrapped WMI (Windows) launch machinery.

`clientConnection` selects the route. Its default, `direct`, uses the URL from
`cortex-client.json`. Setting it to `ssh-reverse` makes the server maintain an
SSH reverse tunnel and inject a loopback WebSocket URL when it launches the
client. `clientReversePort` optionally selects the loopback port on the remote
machine; it defaults to the server's client port and must be between 1024 and
65535. An SSH reverse route requires `ssh`.

The file is watched via `fs.watch()`. General registry readers see updates
within a few hundred milliseconds. Managed client route fields are snapshotted
when client startup begins, so changes to `clientConnection`,
`clientReversePort`, or the associated `ssh` target require a server restart.

## Network topology

The connection from the remote client to the server requires a TCP path to
port 3002. Several options exist depending on the network layout.

### Same LAN

The simplest case. Use the server's LAN IP as `serverHost`:

```json
{ "serverHost": "192.168.1.100", "serverPort": 3002, "deviceName": "lab" }
```

If the connection fails, check the server's firewall:

```bash
sudo ufw allow 3002
```

### Tailscale (recommended for cross-network)

Tailscale assigns each machine a stable CGNAT IP (`100.x.y.z`) regardless of
physical network. The client connects to the server's Tailscale IP:

```json
{ "serverHost": "100.87.154.62", "serverPort": 3002, "deviceName": "lab-ksu" }
```

To find the server's Tailscale IP:

```bash
tailscale ip -4
```

Tailscale works through NAT and firewalls without port forwarding. This is
the recommended option for machines on different networks.

### Cloudflare Tunnel

When both the server and the client are behind NAT with no public IP, run
`cloudflared` on the server to expose its WebSocket port through a tunnel, and
point the client at the tunnel hostname with `serverUrl`. The server's
`cloudflared` ingress maps a hostname to the local WS port:

```yaml
ingress:
  - hostname: cortex.example.com
    service: http://localhost:3002
  - service: http_status:404
```

The client then dials the tunnel over wss/443:

```json
{ "serverUrl": "wss://cortex.example.com", "deviceName": "my-pc", "clientToken": "<token>" }
```

Both sides connect outbound to Cloudflare's edge, so neither needs a public IP
or port forwarding, and WebSocket upgrades pass through the tunnel transparently.

### Managed SSH reverse route

When the server can SSH into the remote machine, Cortex can carry the client
WebSocket back through a persistent reverse forward. Configure the machine on
the server as follows:

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

The server supervises `ssh -N -R
127.0.0.1:13002:127.0.0.1:3002 user@worker`, waits for the SSH control socket,
and launches the client with `CORTEX_SERVER_URL=ws://127.0.0.1:13002`. The
remote listener binds only to loopback. Tunnel failure has its own capped
retry loop, while the client keeps its normal WebSocket reconnect behavior.
The token remains required inside the SSH tunnel.

Use a different `clientReversePort` if the default port is already occupied on
the remote machine. SSH aliases and `ProxyCommand` entries in `~/.ssh/config`
work because the configured `ssh` value is passed as one OpenSSH host argument.

### Externally managed reverse tunnel

A separately supervised SSH tunnel can provide the same network path:

```bash
ssh -N -R 127.0.0.1:3002:127.0.0.1:3002 user@server
```

In that arrangement, configure the client with
`"serverUrl": "ws://127.0.0.1:3002"` and leave `clientConnection` as `direct`,
because Cortex does not own the tunnel process.

### Connection troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Client won't connect | Port 3002 blocked | Check firewall: `sudo ufw allow 3002` |
| Client connects then disconnects | NAT timeout | Use Tailscale or enable TCP keepalive |
| SSH works but WebSocket doesn't | SSH only opens port 22 | Open port 3002 or use Tailscale/reverse tunnel |
| Tailscale installed but can't connect | ACLs blocking | Check `tailscale status` and ACL rules |
| "Device already connected" (code 4002) | Stale connection or duplicate | Kill the old client process on the remote machine |

## WebSocket protocol

The protocol between agent-server and cortex-client is a JSON message stream
over WebSocket. Every HTTP upgrade must carry the shared
`CORTEX_CLIENT_TOKEN` in the `x-cortex-token` header; missing or mismatched
tokens are rejected with HTTP 401. TLS depends on the selected route: a
`wss://` endpoint provides TLS, while direct loopback and SSH-reverse routes
use `ws://` inside their protected transport.

### Client → Server

**Hello** (sent immediately on connect). `bundleHash` identifies the client's
running bundle (sha256 over `client.mjs` + `cortex-run-watcher.mjs`); the
server compares it against the desired bundle to decide whether to push an
update:
```json
{ "type": "hello", "device": "lab", "platform": "linux", "capabilities": ["rg"], "bundleHash": "cebdfcd6…" }
```

**Heartbeat** (every 5 seconds):
```json
{ "type": "heartbeat", "device": "lab", "timestamp": 1716154200000 }
```

**Command result** (in response to a server command):
```json
{ "type": "result", "id": "cmd-abc123", "success": true, "data": { "stdout": "..." } }
```

**Update result** (in response to a server `update` push):
```json
{ "type": "update-result", "device": "lab", "hash": "cebdfcd6…", "ok": true }
```

### Server → Client

**Command**:
```json
{ "type": "command", "id": "cmd-abc123", "action": "bash", "params": { "command": "nvidia-smi" }, "timeout": 120000 }
```

Supported actions: `bash`, `read`, `write`, `edit`, `glob`, `grep`,
`cortex-run.launch`, `cortex-run.cancel`.

**Update** (pushed when a device's hello reports a diverged bundle; `files`
carry the complete artifact as base64):
```json
{ "type": "update", "updateId": "a1b2c3", "version": "2026.7.30-dev", "hash": "cebdfcd6…", "files": [ { "name": "client.mjs", "data": "…" }, { "name": "cortex-run-watcher.mjs", "data": "…" } ] }
```

### Error codes

| Code | Meaning |
|---|---|
| 4001 | Missing device name in hello |
| 4002 | Device already connected |
| 4003 | Heartbeat timeout (15 seconds) |

## Server-side client lifecycle

The `client-manager.ts` module in agent-server manages the remote client
lifecycle:

1. **At startup** — `startAllRemoteClients()` iterates `machines.json` and
   spawns or SSH-launches the client on each machine. For local machines
   (no `ssh` field), it spawns `node ~/.cortex/client/current/client.mjs`
   directly. For remote machines, it runs the launch command over SSH with
   `nohup`/`echo $!` (Linux) or WMI (Windows). An `ssh-reverse` machine first
   gets a supervised reverse tunnel; startup and automatic restart share the
   same route-aware launcher and remote PID tracking. If the launch returns a
   PID but the client has not yet sent `hello`, the server keeps the per-device
   recovery timer armed until that connection arrives.

2. **Heartbeat monitoring** — every 5 seconds, the server checks that each
   connected device has sent a heartbeat within the last 15 seconds.
   Missed heartbeats trigger a disconnect and automatic restart attempt.

3. **Automatic restart** — after initial launch, disconnect, or heartbeat
   timeout, an offline device gets another start attempt after a 60-second
   delay. The server retries until the client connects. A per-device timer
   prevents duplicate restart attempts.

4. **PID tracking** — for SSH-launched clients, the server records the remote
   PID in `~/.cortex/data/client-pids.json` so it can check if the process is
   still alive before attempting a restart.

5. **Command routing** — when the agent calls `remote_bash({ device: "lab",
   ... })`, the MCP server sends an HTTP request to `client-manager`, which
   looks up the WebSocket connection for `lab` in its devices map and sends
   the command. Only online devices receive commands — if the target device
   is offline, the tool call returns an error.

## Client updates

Clients update themselves; the server only publishes the desired bundle. At
startup the server resolves that bundle — in dev mode by building the client
repo with esbuild, in release mode by fetching the latest published
`@cortex-agent/client` from npm (cached per version) — and computes its hash.
Every device hello carries the client's own bundle hash; when it differs from
the desired hash, the server pushes an `update` message with the complete
artifact over the existing WebSocket.

The client writes the files into `~/.cortex/client/next/`, verifies the hash,
rotates `current/` to `previous/` and `next/` to `current/`, reports
`update-result`, closes its socket, spawns its successor from `current/` and
exits. The successor reconnects with the new hash, which the server logs as
convergence. Any failure (bad hash, unwritable disk) leaves the running
version untouched — the device stays online on its old bundle and the server
is told why. A failed install is not retried on the same device for 10
minutes.

Because the trigger is the hello itself, devices converge whenever they
connect: after a server restart with a new build, after a device comes back
from days offline, or right after a bootstrap. There is no scheduled update
job. If a new bundle crashes on startup, the SSH supervision keeps relaunching
`current/`; recovery is `mv ~/.cortex/client/previous ~/.cortex/client/current`
on the device, or a fresh bootstrap.

## Client-side reconnect behavior

The `cortex-client` process handles reconnection automatically:

- On disconnect, it waits 1 second before the first reconnect attempt
- Uses exponential backoff: 1s, 2s, 4s, 8s, 16s, capping at 30 seconds
- If the server rejects with code 4002 ("Device already connected"), the
  client exits. This prevents two clients from fighting over the same device
  name
- For all other disconnects (network errors, server restart, heartbeat
  timeout), the client keeps retrying indefinitely

## Remote command execution

Each command from the server includes an `action` and `params`. The client
dispatches to the appropriate handler:

### bash

Executes in a login shell: `/bin/bash -l -c "<command>"`. On Windows, commands
run through git-bash. The `timeout` parameter uses integer seconds from 1 to
600 and defaults to 120. A foreground timeout returns exit code 124 and kills
the command's process group on POSIX or its process tree on Windows.
`run_in_background: true` returns the detached shell PID immediately and
ignores `timeout`. Managed long-running jobs use `cortex-run`, which provides
stall detection and callback reporting. These remote execution tools are
exposed to agents via the `cortex-core` MCP server — see [mcp.md](./mcp.md).

### read

Reads a file from disk with `fs.readFileSync()`. Supports image files (PNG,
JPEG, WebP, GIF, BMP) with an optional `sharp`-based resize/compress pipeline
(to stay under token budgets), and PDF files handled as embedded resources.
Paths must be absolute.

### write and edit

`write` creates or overwrites a file, creating parent directories if needed.
`edit` finds and replaces a string in an existing file. Successful mutations
return a compact confirmation; session activity records the target path and
device without copying file contents.

### glob and grep

`glob` finds files by pattern (e.g., `**/*.ts`), limited to 500 results and
excluding VCS directories. `grep` uses `rg` (ripgrep) when available, with
a fallback to `grep -rn`. Supports `head_limit` and `offset` for pagination.

### cortex-run (long-running tasks)

For training jobs and other long-running work, `cortex-run.launch` spawns a
`cortex-run-watcher` child process that:
- Monitors the subprocess for stalls (configurable timeout, default 10 minutes
  of no output)
- Writes status, output, and results to JSON files
- Sets a `callback.pending` flag on completion
- The main client flushes pending callbacks on connect and every 60 seconds

`cortex-run.cancel` kills the tracked subprocess by PID.

## Checking device status

From within an agent session, check which devices are online:

```
remote_bash({ device: "lab", command: "hostname" })
```

The agent-server's Slack integration also supports the `!devices` command,
which lists all registered machines with their online/offline status.

From the server's CLI:

```bash
# Check machine registry
cat ~/.cortex/config/machines.json

# Check which clients are connected (via the server logs)
tail -f ~/.cortex/logs/daemon.log | grep client-manager
```

## Security boundary

The remote client system operates with these security constraints:

- The client runs as the same user who started it — no privilege escalation
- Every client WebSocket upgrade requires `CORTEX_CLIENT_TOKEN`. Network
  controls such as a firewall, Tailscale ACL, localhost binding, or an SSH
  reverse route remain defense in depth
- The server's SSH access to remote machines is governed by the SSH key of the
  user running agent-server. The agent cannot escalate beyond what that user
  can do
- MCP tools that target remote devices are subject to the same safety boundary
  rules documented in [safety-and-approvals.md](./safety-and-approvals.md)
- The `cortex-client` npm package installs no postinstall scripts, uses no
  native addons beyond what Node.js ships, and has no external dependencies
  beyond `ws`

## Multi-client routing

There is no automatic device selection. The agent explicitly specifies which
device to target in each tool call via the `device` parameter. The agent
learns about available devices from the `machines.json` registry (visible
through context injection) and from tool descriptions.

For GPU-aware workloads (training), the dispatch system consults `gpuCount`
and can check GPU utilization before assigning work. See [tasks.md](./tasks.md)
for the task dispatch model.

## The client-manage skill

Cortex includes a `client-manage` skill (in the cortex-system plugin) that
provides step-by-step operational guidance for:
- Bootstrapping a new device (register, install, configure, verify, restart)
- Checking online status and connectivity
- Viewing client logs
- Updating client configuration
- Troubleshooting nine common symptoms with root causes and fixes

The skill is available to the agent automatically and serves as the
operational reference for cross-machine management.
