---
name: client-manage
description: "Use when creating, deploying, updating, or troubleshooting cortex-client instances on remote devices"
allowed-tools: Read, Write, Edit, Bash, mcp__cortex-core__remote_bash, mcp__cortex-core__remote_read, mcp__cortex-core__remote_write, mcp__cortex-core__remote_edit, mcp__cortex-core__remote_glob, mcp__cortex-core__remote_grep
metadata:
  author: "Cortex"
  version: "1.4.0"
  date: "2026-05-03"
---

# Client Manage

You are Cortex. You manage remote `cortex-client` instances that run on registered devices. The client connects to the server via WebSocket and executes commands (bash, read, write, edit, glob, grep) on behalf of the server.

The server (`client-manager.ts`) starts clients automatically. Your job is to ensure each device has a working client installation **and a reachable network path** back to the server.

## Architecture

```
cortex-agent-server ──SSH──► starts cortex-client on remote device
        ▲                                    │
        │  WebSocket  wss://<tunnel-host>     │
        │  (or ws://<serverHost>:3002 on LAN) │
        └────────────────────────────────────┘
      (client initiates this connection back to server)
```

**Critical:** The WebSocket connection is initiated FROM the remote device TO the server. The client's target is resolved from `serverUrl` (a full `wss://`/`ws://` URL — used for Cloudflare Tunnel / cross-NAT) or `ws://<serverHost>:<serverPort>` (LAN/Tailscale), and that target MUST be reachable from the remote device. When both server and client are behind NAT, expose the server's WS port via a Cloudflare Tunnel and set the client's `serverUrl` to `wss://<tunnel-host>`. The server's SSH access to the device is separate — it's used for lifecycle management (start/kill/update) but not for the real-time command channel.

## Authentication (WS bearer token)

The server's WebSocket gate is fail-closed: every client must present `CORTEX_CLIENT_TOKEN` (sent as the `x-cortex-token` upgrade header) or the upgrade is rejected with `401`. The server auto-generates the token into its `.env` (`CORTEX_CLIENT_TOKEN`) on first start; read it from the server with `grep CORTEX_CLIENT_TOKEN ~/.cortex/config/.env`.

A remote client gets the token automatically when the server spawns it over SSH (the token is injected into the launch command). Bootstrap only installs files and config; it never creates a device-side service or starts the process. If you start a temporary diagnostic client by hand, export `CORTEX_CLIENT_TOKEN=<token>` in its environment first. Rotating the token means updating the server `.env` and restarting the server-managed clients.

## Config File

`~/.cortex/config/cortex-client.json`:

```json
{
  "serverUrl": "wss://<tunnel-host>",
  "deviceName": "<device-name>",
  "clientToken": "<server CORTEX_CLIENT_TOKEN>"
}
```

The client resolves its server URL by precedence (`server-url.ts`): `CORTEX_SERVER_URL` env > config `serverUrl` > `ws://<serverHost>:<serverPort>`.

- `serverUrl` — **Preferred for cross-NAT / cross-network.** A full WebSocket URL the client dials. When both server and client are behind NAT (no public IP), expose the server's WS port through a **Cloudflare Tunnel** and point every client at `wss://<tunnel-host>` (e.g. the server runs `cloudflared` with an ingress `<tunnel-host> → http://localhost:3002`). The client dials outbound over wss/443 — no inbound or public IP needed on either side. If set, `serverHost`/`serverPort` are ignored.
- `serverHost` / `serverPort` — Legacy LAN/same-machine path: `ws://serverHost:serverPort` (default port 3002). `serverHost` must be an IP the remote device can reach (LAN IP, Tailscale IP, or `127.0.0.1` for same-machine). Use only when there is a direct/Tailscale route; for NAT-to-NAT use `serverUrl`.
- `clientToken` — The server's `CORTEX_CLIENT_TOKEN` (see Authentication). Required unless injected via the `CORTEX_CLIENT_TOKEN` env at launch.
- `deviceName` — Must match the name in `machines.json` on the server.

**This config file is managed by you (LLM).** The server never writes it. Server only starts/kills the client process.

## Connectivity — The Most Important Part

The bidirectional path must work:

```
server → remote:  SSH (server starts/kills/updates client)
remote → server:  WebSocket to <serverHost>:3002 (client connects back)
```

### Verify the Return Path

When bootstrapping a new device or debugging connection issues, ALWAYS verify the remote device can reach the server's WebSocket port:

```bash
ssh user@host "timeout 3 bash -c 'echo > /dev/tcp/<serverHost>/3002' 2>&1 && echo REACHABLE || echo UNREACHABLE"
```

### How to Fix Connectivity

| Situation | Fix |
|-----------|-----|
| Both sides behind NAT (no public IP) | Expose the server WS through a Cloudflare Tunnel; set client `serverUrl` to `wss://<tunnel-host>` (preferred when neither side is publicly reachable) |
| Same LAN, unreachable | Check firewall: `sudo ufw allow 3002` on server |
| Different network | Use Tailscale IP (works through NAT) or a Cloudflare Tunnel `serverUrl` |
| STCP tunnel only | Use Tailscale or set up reverse SSH: `ssh -R 3002:localhost:3002 user@host` on server |
| Tailscale but unreachable | `tailscale status` — ensure both devices are connected, check ACLs |
| Can SSH but can't TCP | SSH works on port 22 only. Either open port 3002 or use Tailscale / Cloudflare Tunnel / reverse tunnel |

### Determine the Right serverHost

```bash
# On the server, get candidate IPs:
tailscale ip -4               # Tailscale CGNAT (works everywhere) — PREFERRED
hostname -I | awk '{print $1}'  # Primary LAN IP
```

Test each candidate from the remote device. Use the first one that works.

## Device Reference

Read `machines.json` on the server for the current device list. Key fields per device:

- `ssh` — How the server reaches this device (empty = local)
- `cortexPath` — Path to user's workspace on the device
- `gpuCount` — Number of GPUs
- `win` — `true` for Windows
- `clientCommand` — (optional) command the server runs over SSH to launch the client; defaults to `node "$HOME/.cortex/client/current/client.mjs"` (`%USERPROFILE%` on Windows). Override on machines where `node` isn't on the **non-login** SSH PATH — e.g. nvm installs: set an absolute node path like `"/home/u/.nvm/versions/node/v20.19.5/bin/node /home/u/.cortex/client/current/client.mjs"`. See Troubleshooting.

## Bootstrap — New Device

### 1. Register in machines.json

Edit `machines.json` on the server to add the device entry.

### 2. Deploy the client bundle

The client is two self-contained files under `~/.cortex/client/current/` on the device — no npm install. Either run the install-only bootstrap CLI (it does not start the client or create systemd/launchd/scheduled-task entries):

```bash
cd <cortex-repo>/agent-server && node --import tsx src/domain/remote/client-bootstrap.ts \
  --host user@host --device-name <device-name> --server-host <serverHost>
```

or place the bundle by hand:

```bash
# Build from source (dev) — produces dist/client.mjs + dist/cortex-run-watcher.mjs
cd <cortex-repo>/client && npm run bundle

# Ship to the device
ssh user@host "mkdir -p ~/.cortex/client/current"
scp dist/client.mjs dist/cortex-run-watcher.mjs user@host:.cortex/client/current/
```

### 3. Write the config

First, determine the correct `serverHost` (see Connectivity section above). Then write:

```bash
ssh user@host 'mkdir -p ~/.cortex/config && cat > ~/.cortex/config/cortex-client.json << EOF
{
  "serverHost": "<REACHABLE_IP>",
  "serverPort": 3002,
  "deviceName": "<device-name>"
}
EOF'
```

Or use `mcp__cortex-core__remote_write` if the device is already reachable via another client.

### 4. Verify connectivity

```bash
ssh user@host "timeout 3 bash -c 'echo > /dev/tcp/<serverHost>/3002' 2>&1 && echo REACHABLE || echo UNREACHABLE"
```

### 5. Start or restart the server

The agent-server is the sole lifecycle owner. Once it starts with the device registered in `machines.json`, it launches the installed client and keeps retrying until the client connects. Do not configure systemd, launchd, scheduled tasks, tmux, or screen to start cortex-client on the device.

## Maintenance

### Check if a client is online

```
mcp__cortex-core__remote_bash({ device: "<device-name>", command: "hostname" })
```

"Device is not online" means the client is down or disconnected.

### View client logs

```bash
ssh user@host "tail -20 ~/.cortex/logs/client-\$(date +%Y%m%d).log"
```

### Update cortex-client

Updates are automatic: every client reports its bundle hash in its hello, and the server pushes the desired bundle over the WebSocket when they differ. The client installs into `~/.cortex/client/next/`, verifies the hash, rotates `current/`→`previous/`, re-execs itself and reconnects. No manual npm/scp step exists in the normal path.

To force a refresh, kill the client — the server relaunches it and the reconnect hello triggers the push if the device is behind:

```bash
ssh user@host "pkill -f client.mjs"
```

If a bad bundle leaves the client unable to start, roll back or redeploy:

```bash
ssh user@host "rm -rf ~/.cortex/client/current && mv ~/.cortex/client/previous ~/.cortex/client/current"
# or re-run the bootstrap deployment (step 2 above)
```

### Edit the config

```
mcp__cortex-core__remote_edit({
  device: "<device-name>",
  file_path: "~/.cortex/config/cortex-client.json",
  old_string: "\"serverHost\": \"<old-ip>\"",
  new_string: "\"serverHost\": \"<new-ip>\""
})
```

After editing, kill the client — server will restart it:

```bash
ssh user@host "pkill -f 'node.*cortex-client'"
```

## Troubleshooting

| Symptom | Likely Cause | Check |
|---------|-------------|-------|
| "Device is not online" | Client process died | `ssh user@host "pgrep -f client.mjs"` |
| Client exits on start | Config missing or bad serverHost | Check `~/.cortex/config/cortex-client.json` exists and serverHost is reachable |
| "Device already connected" | Stale process | `ssh user@host "pkill -f client.mjs"`, server will restart |
| WebSocket connect EHOSTUNREACH | Wrong serverHost | Verify with `/dev/tcp` test, fix the IP |
| `Unexpected server response: 401` | Missing/mismatched `CORTEX_CLIENT_TOKEN` | Ensure the client's env has the server's token (see Authentication); restart the client |
| Exit code 127 | `node` not on the non-login SSH PATH, or bundle missing | `ssh user@host "which node; ls ~/.cortex/client/current"`; set an absolute node path in `clientCommand`, or redeploy the bundle |
| Runs when started by hand but never reconnects after an auto-restart (nvm machines) | Server's SSH auto-restart uses a **non-login** shell where nvm's `node` isn't on PATH — `ssh user@host "which node"` returns empty | Set an absolute node path in `clientCommand` in `machines.json` |
| Server can't SSH to device | SSH key or tunnel issue | `ssh user@host hostname` from server |
