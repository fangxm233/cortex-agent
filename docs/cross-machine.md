# Cross-Machine Operation

Cortex can dispatch work to remote machines: run commands, read and write
files, search code, and execute long-running training jobs. This is done
through `cortex-client`, a lightweight WebSocket daemon that runs on each
remote machine and connects back to the agent-server. This document covers
deployment, the network topology, and the security model.

## Why remote clients

The agent-server process (which runs the agent sessions, the chat platforms,
and scheduling) may not be on the machine with the GPUs or the project files. A
typical setup:

- `hub` — the agent-server host (GPU training, simulation, the Cortex
  daemon itself)
- `trainer` — a dedicated training box on the LAN with its own GPU
- `cluster` — a remote training cluster reached through a tunnel
- `desk` — a Windows workstation for Unity, VR, and documentation

Each remote machine runs `cortex-client`, which connects to the agent-server
and executes commands on that machine's behalf. The agent sees all machines as
a flat pool and selects which device to target per tool call.

## Architecture

For the full server-side architecture including the six-layer structure,
event bus, and WebSocket protocol details, see [architecture.md](./architecture.md).

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

Each `cortex-client` instance:
- Connects to the agent-server's WebSocket server (port 3002), presenting
  `CORTEX_CLIENT_TOKEN`
- Registers itself with a device name on connect (`hello` message)
- Sends a heartbeat every 5 seconds
- Receives command messages and executes them on the local machine
- Returns results over the same WebSocket connection, and opens separate
  callback sockets for file transfers and port forwards

## Installing cortex-client

### Prerequisites

- Node.js ≥ 20
- Either a direct WebSocket path from the remote machine to the agent-server,
  or an SSH path from the agent-server to the remote machine for a managed
  reverse route
- Network path from the agent-server to the remote machine on port 22 (SSH),
  if the server needs to start/restart the client remotely

### Installation

The client ships as one self-contained bundle — `client.mjs` — that lives on each
device under the managed layout. A second file, `cortex-run-watcher.mjs`, is
shipped alongside it as an empty compatibility stub: the update package is
validated by file name on both ends, so a client installed before `cortex-run`
was removed would otherwise refuse every future update.

```
~/.cortex/client/
├── current/    # the running version (client.mjs + a compatibility stub)
└── previous/   # the prior version, kept for manual rollback
```

New local desktop installations explicitly request client preparation during init.
The server package carries the two client files built from the same source checkout;
init prepares them under `<CORTEX_HOME>/client/current/` and creates the local client
configuration. The server records ownership in `client/local-install.json` and
recovers interrupted preparation when starting its client. Existing unowned client
files or user-edited configuration are not taken over. Ordinary init and remote
connections do not request this preparation. The local client uses the server's Node
and selected environment, with the loopback WebSocket URL and token supplied at launch.
App-only reopen preserves the running daemon; server startup handles client recovery.

Nothing is installed through npm on a remote device; the only requirement is Node.js.
The server's bootstrap script installs the remote device files — it checks SSH and Node.js,
ships the bundle into `~/.cortex/client/current/`, and writes a client config with
`serverHost`, `serverPort` and `deviceName`. It does not start the client or create a
device-side service. It runs from the `agent-server/` directory of a source checkout,
targets Linux and macOS devices, and takes `--host`, `--device-name` and `--server-host`
(all required) plus `--server-port` (default 3002):

```bash
node --import tsx src/domain/remote/client-bootstrap.ts \
  --host user@machine --device-name trainer --server-host 192.0.2.10
```

For a device that dials a `serverUrl` instead, edit `cortex-client.json` after bootstrap.

Bootstrap is also the rescue path when a device's managed install is broken
or wiped. Register the device in the server's `machines.json`, run bootstrap,
then start or restart the agent-server. The server owns client startup and
recovery; do not create a systemd, launchd, scheduled-task, tmux, or screen
autostart entry on the client device.

### Configuration

Create `~/.cortex/config/cortex-client.json` on the remote machine:

```json
{
  "serverHost": "192.0.2.10",
  "serverPort": 3002,
  "deviceName": "trainer"
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
  server's `machines.json`. Defaults to the machine's hostname

The environment variables `CORTEX_SERVER_URL` and `CORTEX_CLIENT_TOKEN`, when
set, take precedence over `serverUrl` and `clientToken`. The client honors
`CORTEX_HOME` for its config, install and log directories, and writes its log
to `~/.cortex/logs/client-YYYYMMDD.log`, kept for 14 days.

For diagnostics, `cortex-client` can be run in the foreground with the token in
its environment. Production clients are started and supervised by the
agent-server; a second device-side supervisor creates competing lifecycle
owners and must not be configured.

## Registering machines on the server

Machines are registered in `~/.cortex/config/machines.json` on the agent-server
host:

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

Each entry:
- `cortexPath` (required) — the working directory path on that machine
- `gpuCount` (required) — number of GPUs (0 for non-GPU machines). Each client
  probes its own machine with `nvidia-smi` and reports the count when it connects;
  the server writes a differing value straight back into this file, so a stale
  number corrects itself on the next connection. A machine where `nvidia-smi`
  cannot run reports nothing and keeps the value you set here.
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
machine; it is valid only with `ssh-reverse`, defaults to the server's client
port, and must be between 1024 and 65535. An SSH reverse route requires `ssh`.

An invalid `machines.json` stops the server at startup. When an edit made
while the server runs fails validation, the server keeps the previous registry
and sends an admin notice. The file is watched via `fs.watch()`. General
registry readers see updates within a few hundred milliseconds. Managed client route fields are snapshotted
when client startup begins, so changes to `clientConnection`,
`clientReversePort`, or the associated `ssh` target require a server restart.
Deleting an entry takes effect on the same reload: the server stops that
machine's SSH reverse tunnel and cancels its pending client restart.
`cortex client remove --device <name>` deletes the entry and also stops and
uninstalls the client on the machine (see the
[CLI reference](./cli-reference.md)).

## Network topology

The connection from the remote client to the server requires a TCP path to
port 3002. Several options exist depending on the network layout.

### Same LAN

The simplest case. Use the server's LAN IP as `serverHost`:

```json
{ "serverHost": "192.168.1.100", "serverPort": 3002, "deviceName": "trainer" }
```

If the connection fails, check the server's firewall:

```bash
sudo ufw allow 3002
```

### Tailscale (recommended for cross-network)

Tailscale assigns each machine a stable CGNAT IP (`100.x.y.z`) regardless of
physical network. The client connects to the server's Tailscale IP:

```json
{ "serverHost": "100.64.12.34", "serverPort": 3002, "deviceName": "cluster" }
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
{ "serverUrl": "wss://cortex.example.com", "deviceName": "desk", "clientToken": "<token>" }
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

The server supervises an OpenSSH master connection that carries
`-R 127.0.0.1:13002:127.0.0.1:3002` to `user@worker`, with
`ExitOnForwardFailure=yes` and a 15-second keepalive. Before each start it
frees a stale listener left on the remote port by an earlier tunnel, then
waits for the SSH control socket and launches the client with
`CORTEX_SERVER_URL=ws://127.0.0.1:13002`. The remote listener binds only to
loopback. Tunnel failure has its own retry loop, backing off from 1 to 30
seconds, while the client keeps its normal WebSocket reconnect behavior. The
token remains required inside the SSH tunnel. Control sockets live under
`$CORTEX_HOME/data/client-ssh-tunnels/`, and the route each client was started
on is recorded in `$CORTEX_HOME/data/client-routes.json`, so a client left
running on a route that no longer matches the configuration is stopped and
relaunched.

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
| "Unknown device" (code 4005) | `deviceName` not in `machines.json` | Add the machine, or fix `deviceName` |
| HTTP 401 on connect | Missing or wrong `CORTEX_CLIENT_TOKEN` | Let the server launch the client, or copy the token from the server's `config/.env` |

The client's own log, `~/.cortex/logs/client-YYYYMMDD.log` on the device,
records each connection attempt and close code.

## WebSocket protocol

The protocol between agent-server and cortex-client is a JSON message stream
over WebSocket. Every HTTP upgrade must carry the shared
`CORTEX_CLIENT_TOKEN` in the `x-cortex-token` header; missing or mismatched
tokens are rejected with HTTP 401. TLS depends on the selected route: a
`wss://` endpoint provides TLS, while direct loopback and SSH-reverse routes
use `ws://` inside their protected transport.

### Client → Server

**Hello** (sent immediately on connect). `bundleHash` identifies the client's
running bundle (sha256 over the bundle files in order); the
server compares it against the desired bundle to decide whether to push an
update. `gpuCount` is the client's own `nvidia-smi` count, or `null` when it
cannot probe, and `pid` is the client's process id, which the server records
for a client on its own machine:
```json
{ "type": "hello", "device": "trainer", "platform": "linux", "capabilities": ["file-stream", "rg"], "gpuCount": 1, "bundleHash": "cebdfcd6…", "pid": 41822 }
```

**Heartbeat** (every 5 seconds):
```json
{ "type": "heartbeat", "device": "trainer", "timestamp": 1716154200000 }
```

**Command result** (in response to a server command; `error` replaces `data`
when `success` is false):
```json
{ "type": "result", "commandId": "cmd-abc123", "success": true, "data": { "stdout": "..." } }
```

**Update result** (in response to a server `update` push):
```json
{ "type": "update-result", "device": "trainer", "hash": "cebdfcd6…", "ok": true }
```

### Server → Client

**Command**:
```json
{ "type": "command", "commandId": "cmd-abc123", "action": "bash", "params": { "command": "nvidia-smi", "timeout": 120000 } }
```

Supported actions: `bash`, `read`, `write`, `edit`, `glob`, `grep`, `file.stat`.
A bash time limit travels in `params.timeout` in milliseconds. The server
keeps its own timer for every command — the call's own limit when it sets one,
otherwise 120 seconds for bash and 30 seconds for file actions — and fails the
call if no result arrives in time.

**Open stream** (a port forward: the client dials back and pipes a raw TCP
connection to a loopback port on the device; see
[Port forwarding](#port-forwarding)):
```json
{ "type": "open-stream", "streamId": "4be1…", "host": "127.0.0.1", "port": 6006 }
```

**Open file stream** (sent when the server wants a whole file off the device,
e.g. `send_file device="trainer"`). Like `open-stream`, it is answered on a new
outbound socket rather than on this one, so a large transfer neither blocks
commands nor has to be base64'd through the control channel:
```json
{ "type": "open-file-stream", "streamId": "9f3c…", "path": "/home/x/report.csv" }
```

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
| 4004 | Unknown stream: a callback socket named a stream the server is not expecting |
| 4005 | Unknown device: hello name is not registered in `machines.json` |
| 1001 | Server shutting down |

## Server-side client lifecycle

Two modules in agent-server's `domain/remote/` share the remote client
lifecycle: `client-manager.ts` holds the device connections (heartbeats and
command routing), and `client-lifecycle.ts` launches, tracks and restarts the
clients:

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

4. **PID tracking** — the server records each launched client's PID, local or
   remote, in `~/.cortex/data/client-pids.json` so it can check whether the
   process is still alive before attempting a restart.

5. **Command routing** — when the agent calls `remote_bash({ device: "trainer",
   ... })`, the MCP server sends an HTTP request to `client-manager`, which
   looks up the WebSocket connection for `trainer` in its devices map and sends
   the command. Only online devices receive commands — if the target device
   is offline, the tool call returns an error.

## Client updates

Clients update themselves; the server publishes the desired bundle. For an
App-enrolled local client, that bundle comes from the installed server package,
with its ordered file hash verified; a missing or invalid payload does not fall
back to npm. For other clients, a server running from a source checkout
(`CORTEX_REPO` or `CORTEX_CLIENT_REPO` set) builds the client repo with esbuild,
and an installed server fetches the latest published `@cortex-agent/client`
from npm, cached per version under `$CORTEX_HOME/data/client-bundles/`. Every
device hello carries the client's own bundle hash; when it differs from the
desired hash, the server pushes an `update` message with the complete artifact
over the existing WebSocket. Successful and failed installs are announced as
chat notices. Setting `clientHotReloadEnabled` to `false` in `settings.json`
turns update pushes off, and an existing local client version is then
preserved rather than replaced during preparation.

The client writes the files into `~/.cortex/client/next/`, verifies the hash,
rotates `current/` to `previous/` and `next/` to `current/`, reports
`update-result`, closes its socket, spawns its successor from `current/` and
exits. The successor reconnects with the new hash, which the server logs as
convergence. Any failure (bad hash, unwritable disk) leaves the running
version untouched — the device stays online on its old bundle and the server
is told why. A failed install is not retried on the same device for 10
minutes, and a push that is in flight or has just been installed is not
repeated for 2 minutes.

Because the trigger is the hello itself, devices converge whenever they
connect: after a server restart with a new build, after a device comes back
from days offline, or right after a bootstrap. There is no scheduled update
job. If a new bundle crashes on startup, the SSH supervision keeps relaunching
`current/`. For manual recovery, move the failing version aside, then restore
`previous/` on the device, or run a fresh bootstrap. These are real directories,
not symlinks: `current/` must be absent before moving `previous/` into its place.
The commands below keep the failing version in `broken/` and require that name
to be unused; choose another unused name if needed. Use your client install root
if it differs from `~/.cortex/client`.

Linux/macOS (Bash):

```bash
cd ~/.cortex/client &&
  test -d previous && test ! -e broken &&
  mv current broken && mv previous current
```

Windows (PowerShell):

```powershell
& {
  Set-Location "$HOME/.cortex/client" -ErrorAction Stop
  if (-not (Test-Path -LiteralPath previous -PathType Container)) { throw 'previous/ is missing' }
  if (Test-Path -LiteralPath broken) { throw 'Choose an unused backup name for broken/' }
  Move-Item -LiteralPath current -Destination broken -ErrorAction Stop
  Move-Item -LiteralPath previous -Destination current -ErrorAction Stop
}
```

## Client-side reconnect behavior

The `cortex-client` process handles reconnection automatically:

- On disconnect, it waits 1 second before the first reconnect attempt
- Uses exponential backoff: 1s, 2s, 4s, 8s, 16s, capping at 30 seconds
- If the server rejects with code 4002 ("Device already connected"), the
  client exits. This prevents two clients from fighting over the same device
  name
- If the server rejects with code 4005 ("Unknown device"), the client exits.
  Its `deviceName` must match an entry in `machines.json`, including for a
  local client whose entry has no `ssh` field
- For all other disconnects (network errors, server restart, heartbeat
  timeout), the client keeps retrying indefinitely

## Remote command execution

Each command from the server includes an `action` and `params`. The client
dispatches to the appropriate handler:

### bash

Executes in a login shell: `/bin/bash -l -c "<command>"`. On Windows, commands
run through Git Bash, found at `CORTEX_GIT_BASH_PATH` when that is set, then in
the standard Program Files locations, then on `PATH`. The `timeout` parameter
uses integer seconds from 1 to 600 and defaults to 120. A foreground timeout
returns exit code 124 and kills the command's process group on POSIX or its
process tree on Windows. Output is cut to its head and tail beyond 200 KB of
stdout or 50 KB of stderr.
`run_in_background: true` returns the detached shell PID immediately and
ignores `timeout`. Cortex does not supervise long-running jobs: start one
yourself and have it report back through a [waitpoint](./waitpoints.md). These
remote execution tools are exposed to agents via the `cortex-core` MCP server —
see [mcp.md](./mcp.md).

### read

Reads a file from disk. Paths must be absolute, and files over 10 MB are
refused. Text is returned with line numbers, 2,000 lines by default, and a
range over about 25,000 words is refused with a suggested `limit`. Image files
(PNG, JPEG, WebP, GIF, BMP) and PDFs come back whole as base64; the server's
`remote_read` tool then downscales large images when `sharp` is available.

### file.stat

Metadata probe — size, base name, mtime — used before a file transfer so a bad
path or an oversized file fails with a real error message instead of an aborted
stream. Paths must be absolute.

### Sending a device's file to the chat

`send_file` (and `slack_send_file` / `feishu_send_file`) take an optional
`device`. With it, the path is read on that device and the bytes are streamed
back over the reverse channel, then delivered as an ordinary attachment:

```js
send_file({ device: "trainer", file_path: "/home/x/runs/loss.png", caption: "latest curve" })
send_file({ device: "trainer", files: [{ file_path: "/home/x/runs/loss.png" }, { file_path: "/home/x/runs/eval.csv" }] })
```

The server refuses before transferring anything if the device is offline, the
path is not a readable file, or it exceeds the 200 MB cap, and it rejects a
transfer that ends short rather than delivering a truncated file. Devices
running a client older than this feature report no `file-stream` capability and
are refused with a message saying so; they gain it on their next
[client update](#client-updates).

### write and edit

`write` creates or overwrites a file, creating parent directories if needed.
`edit` finds and replaces a string in an existing file. Successful mutations
return a compact confirmation; session activity records the target path and
device without copying file contents.

### glob and grep

`glob` finds files by pattern (e.g., `**/*.ts`), limited to 500 results and
excluding VCS directories, `node_modules`, `__pycache__`, `.tox` and
`.mypy_cache`. `grep` uses `rg` (ripgrep) when available, with `head_limit`
(default 250) and `offset` for pagination. When `rg` is not installed it falls
back to `grep -rn`, which ignores the pagination, glob, type and context
options.

### Remote AGENTS.md files

On `read`, `write` and `edit`, the client also walks up from the target file
and returns the `AGENTS.md` and `AGENTS.local.md` files it finds (up to 20
levels, each up to 200 KB), plus the one at the device's `~/.cortex/AGENTS.md`.
The `remote_read`, `remote_write` and `remote_edit` tools add each of them to
their result once per session, so instructions that live next to a project on
a device reach the agent the same way local ones do.

### Port forwarding

The server can map a loopback port on a device to a loopback port on its own
machine (at most 32 at a time): each connection to the server-side port makes
the server send `open-stream`, and the client dials back and pipes the bytes to
`127.0.0.1:<port>` on the device. Two features use it:

- **A browser on a device.** The composer's browser selector offers this host
  and every connected device. Choosing a device starts Chrome there and
  connects the session's browser tools through a forwarded debugging port. The
  browser is shared by turns on that device and closed after 10 idle minutes.
- **The docked browser's ports panel** lists ports listening on the server or
  a connected device and previews them in the desktop app, with a remote port
  forwarded first.

### Long-running jobs

Cortex does not launch, supervise or adopt processes on a device. Start the job
the way you normally would (`nohup`, `setsid`, tmux, a scheduler) and arm a
[waitpoint](./waitpoints.md) so the session is woken when it finishes. On a
device the job drops a small JSON file in `~/.cortex/tmp/signals/`. On each
sweep the server lists, reads and removes those files with ordinary `bash`
commands over the connection this client already holds open — only on devices
that have an armed waitpoint — so nothing extra has to be installed there.

## Checking device status

The agent sees the registered devices in the description of its remote tools,
and a call to an offline device fails with the list of devices that are
online. A quick probe:

```
remote_bash({ device: "trainer", command: "hostname" })
```

In the Web UI and desktop app, the machines chip in the top bar shows how many
machines are online and opens a sheet with each machine's GPUs, processes,
load, memory, disk and uptime, probed on demand with one shell command over the
client. In Slack or Feishu, `!devices` (alias `!clients`) lists the registered
and connected machines with their platform, connection age and last heartbeat.

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
- Port forwards bind to loopback on the server and reach only loopback ports
  on the device

## Multi-client routing

There is no automatic device selection. The agent explicitly specifies which
device to target in each tool call via the `device` parameter. It learns the
available devices from the catalog in the remote tools' description, built
from `machines.json` with Windows machines marked.

For GPU-aware workloads (training), the agent can read each machine's
`gpuCount` from the registry and check GPU utilization on the device before
choosing where to run.

## The client-manage skill

Cortex includes a `client-manage` skill (in the cortex-system plugin) that
provides step-by-step operational guidance for:
- Bootstrapping a new device (register, install, configure, verify, restart)
- Checking online status and connectivity
- Viewing client logs
- Updating client configuration
- Troubleshooting common symptoms with root causes and fixes

The skill is available to the agent automatically and serves as the
operational reference for cross-machine management.
