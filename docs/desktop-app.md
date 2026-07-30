# Desktop App

The Cortex desktop app is a native window (built with [Tauri v2](https://tauri.app)) that
wraps the Cortex web workbench. It connects directly to any running Cortex server using the
HTTP tRPC transport with a `clientToken` — no local proxy or sidecar required.

## Installation

Download the latest release for your platform from the
[GitHub Releases page](https://github.com/fangxm233/cortex-agent/releases).

### Linux

**AppImage (any distribution):**

```bash
chmod +x Cortex_*.AppImage
./Cortex_*.AppImage
```

**Debian / Ubuntu (.deb):**

```bash
sudo apt install ./Cortex_*_amd64.deb
cortex-desktop          # or launch from your application menu
```

**System prerequisites (Ubuntu 22.04 +):**

```bash
sudo apt-get install libwebkit2gtk-4.1-0 libgtk-3-0
```

Most Ubuntu/Debian desktops already have these. If the app fails to start with a missing-library
error, install them with the command above.

### macOS

Download `Cortex_*_x64.dmg` (Intel) or `Cortex_*_aarch64.dmg` (Apple Silicon).

1. Open the `.dmg` file.
2. Drag **Cortex** to your **Applications** folder.
3. Open **Cortex** from Applications or Spotlight.

On first launch macOS may warn "Apple cannot verify this developer." Click **Open Anyway** in
**System Settings → Privacy & Security**.

### Windows

Download `Cortex_*_x64-setup.exe`. Run the installer and follow the prompts.
Cortex appears in the Start menu after installation.

**WebView2 requirement:** Windows 10 / 11 normally includes the WebView2 runtime. If the app
fails to launch with a WebView2 error, download the Evergreen bootstrapper from
[Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/).

## Prerequisites on the server side

The desktop app talks to the Cortex server's **Web UI HTTP endpoint** over HTTP or HTTPS.
This endpoint is **opt-in** — you must enable it before the desktop can connect.

The endpoint is served by the server's **in-core** Web UI transport, which it loads on demand only
when `CORTEX_UI_HTTP` is set (it carries `@trpc/server` + `jose` and the SPA host — runtime-lazy, so
they never load for a Slack/TUI-only server). Enabling it is the same one-line flag as before —
**nothing changes for the desktop app**, which still authenticates with a bearer `clientToken`. The
same endpoint also powers the browser workbench; see [Browser Access & Deployment](browser-access.md).

Add the following to `~/.cortex/config/.env` on the machine running the Cortex server:

```bash
CORTEX_UI_HTTP=1          # enables the tRPC HTTP + SSE endpoint
CORTEX_UI_PORT=3004       # optional; defaults to 3004
```

Then restart the Cortex daemon:

```bash
cortex daemon   # or systemctl --user restart cortex (if you registered a system service)
```

If you expose the endpoint through a tunnel (recommended for remote access), point the tunnel
at the port above and use the resulting HTTPS URL when connecting from the desktop app.

## First-run: connecting to your server

The first time you launch Cortex desktop, the **connection screen** appears:

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

### Step 1 — Enter the Server URL

Enter the HTTP/HTTPS URL where your Cortex Web UI endpoint is reachable, for example:

- Same machine, no tunnel: `http://localhost:3004`
- Remote server via Cloudflare tunnel: `https://cortex-ui.your-domain.com`

### Step 2 — Enter the Client Token

The client token is the shared secret your server uses to authenticate Cortex clients
(the same token in `~/.cortex/config/.env` as `CORTEX_TOKEN`). You can retrieve it with:

```bash
grep CORTEX_TOKEN ~/.cortex/config/.env
```

### Step 3 — Test the connection

Click **test connection**. The app sends a lightweight probe to `<serverUrl>/trpc` with the
token header.

- **Connected** (green) — server is reachable and the token is valid.
- **Unauthorized** (amber) — server is reachable but the token is wrong.
- **Network error** (red) — the URL is unreachable (server down, tunnel not running, wrong URL).

### Step 4 — Connect

Click **connect →**. The app:

1. Saves the credentials to your OS keychain (macOS Keychain, Windows Credential Manager,
   or Linux SecretService / GNOME Keyring).
2. Opens the workbench.

On all **subsequent launches**, Cortex reads the stored credentials and goes directly to the
workbench — the connection screen is skipped.

## Usage

Once connected, you have access to the full Cortex workbench:

### Main workbench

The workbench is a three-panel layout:

| Panel | Contents |
|---|---|
| Left rail | Project/session navigator. Switch projects and session archives. |
| Center | Conversation: thread steps, tool calls, assistant output, approval prompts. |
| Right panel | Active threads/tasks/machines; cost bar; step-detail tree. |

### Thread detail

Click any thread card in the right panel to open the **thread detail view** — a full step-by-step
trace of the agent's plan, execution, and sub-dispatches, with per-step timing and cost.

### ⌘K / Ctrl+K — Command palette

Press `⌘K` (macOS) or `Ctrl+K` (Windows/Linux) to open the command palette. Type to filter
across sessions, threads, and tasks. Press Enter to navigate; Escape to close.

### Execution log drawer

Click a running execution pill in the right panel or thread detail to open the **execution log
drawer** — a live-streaming view of the execution's stdout/stderr. Logs stream in real time via
SSE. A **Kill** button cancels the execution.

### Project and archive switcher

The left rail shows the current project. Click the project name to open the **project switcher**
and pick a different project. Click the session archive icon to switch to historical archive view.

### Task popup

Click any task row in the right panel or command palette to open the **task popup**, showing the
task's full description, `done-when` criteria, status, and dependency chain.

### Overview

The **Overview** tab in the right panel shows system-wide cost, scheduled tasks, recent
executions, and throughput charts.

## Switching to a different server

A **Switch** button appears in the bottom-right corner of the workbench window when you move the
mouse. Clicking it:

1. Clears the stored credentials from the OS keychain.
2. Returns to the connection screen.

You can then enter a different server URL and token.

## Updates

The app keeps itself up to date through two channels, both driven by the server it is
connected to. You never need to check for new versions manually.

**Frontend (silent).** After launch, the app compares its bundled web UI against the one the
server serves. When the server has a newer UI, the app downloads it in the background, verifies
it, and stages it for the next launch — a small "restart to update" prompt appears when it is
ready. This covers most releases: anything that only changes the UI arrives this way, with no
reinstall.

**App shell (one prompt per release).** Some releases also ship new native app packages,
attached to the GitHub release. The server advertises the newest package set that matches its
own version — the app is never offered a version newer than the server it talks to, so the two
stay in step and a release means at most one update prompt per device. The app downloads the
package for its platform in the background, verifies its SHA-256 against the GitHub-published
digest, and then shows a dialog with three choices: install, skip this version, or later.

What "install" does depends on the platform:

- **Linux (AppImage)** — the app replaces its own file (keeping the previous one as `.old`
  beside it) and restarts. Fully automatic.
- **Windows** — the app exits and launches the downloaded installer; step through it and
  reopen Cortex.
- **macOS** — the disk image is saved to Downloads and opened; drag Cortex into Applications
  to finish.
- **Linux (deb/rpm)** — the package is saved to Downloads and opened with the system package
  installer.
- **Android** — the system package installer opens over the verified APK; confirm to upgrade.
  On first use Android asks you to allow installs from Cortex.

Running threads live on the server, so restarting or reinstalling the app never interrupts
them. Development runs — a shell serving the SPA from a local directory via
`CORTEX_FRONTEND_DIR` — never check for shell updates. Setting
`CORTEX_APP_UPDATE_DISABLE=1` in the app's environment turns the check off entirely.

## How the connection works

The desktop app bypasses the browser's same-origin restriction by using:

- **tRPC HTTP batch** over `POST <serverUrl>/trpc` for all queries and mutations.
  Every request carries the `x-cortex-token` header.
- **SSE subscriptions** via an EventSource ponyfill (fetch-based) that can set custom request
  headers. Real-time thread and execution updates arrive without polling.

This architecture means the desktop app can connect to any Cortex server on any machine — local
or remote — as long as the Web UI endpoint is reachable.

## Troubleshooting

**"Unauthorized" on test connection**

The client token is wrong. Check `CORTEX_TOKEN` in `~/.cortex/config/.env` on the server.

**"Network error" on test connection**

1. Confirm the server is running: `cortex daemon` (or check `systemctl --user status cortex`).
2. Confirm `CORTEX_UI_HTTP=1` is set in the server's `.env` and the server was restarted after
   adding it.
3. Check that the URL is reachable: `curl <serverUrl>/trpc` should return a tRPC error (not
   a connection-refused error).
4. If using a tunnel, confirm the tunnel is up and the route points to the correct port.

**Credentials lost on restart (Linux headless servers)**

On headless Linux servers without a SecretService daemon (e.g., servers without GNOME Keyring
running), the OS keychain is unavailable. Credentials survive for the current session only
(stored in process memory) and are lost when the app exits.

To work around this, set environment variables before launching the app:

```bash
CORTEX_SERVER_URL=http://localhost:3004 CORTEX_TOKEN=<your-token> ./Cortex.AppImage
```

These env vars seed the AppState at startup and bypass the keychain check.

**App window does not open (Wayland)**

Tauri v2 supports Wayland. If the window does not appear, try forcing X11 compatibility:

```bash
GDK_BACKEND=x11 ./Cortex.AppImage
```
