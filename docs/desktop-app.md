# Desktop and Android Apps

Cortex provides a Tauri v2 native shell for Linux, macOS, Windows, and Android. The desktop shell presents the three-pane workbench; Android presents a phone-specific four-tab interface. Both connect directly to a Cortex server over the Web UI HTTP transport and use the same projects, sessions, tasks, threads, approvals, files, and memory as the browser workbench.

The native apps require a reachable Web UI endpoint and the server's `CORTEX_CLIENT_TOKEN`. Browser access uses a separate Cloudflare Access path described in [Browser Access](browser-access.md).

The desktop app can either install a Cortex server on the computer it runs on or connect to one that already exists. The first screen asks which, and the local path needs no terminal: it installs the package, writes the configuration, starts the daemon, and connects. Android is remote-only, since it has no place to run a Node process.

Browser access uses a separate Cloudflare Access path described in [Browser Access](browser-access.md).

## Installation

For server releases that include native packages, download the platform asset from the [GitHub Releases page](https://github.com/fangxm233/cortex-agent/releases). The release policy assigns the native UI exactly the same CalVer as the corresponding server release: `YYYY.M.D[-N]`. The version embedded in the app and shown in the asset name must match the `server-v<version>` tag.

| Platform | Native release package | Installation |
|---|---|---|
| Linux x86_64 | AppImage, DEB, or RPM | Run the AppImage directly after `chmod +x`, or install the distribution package. |
| Windows x86_64 | NSIS `setup.exe` | Run the installer and launch Cortex from the Start menu. |
| macOS universal | Universal DMG for Intel and Apple Silicon | Open the DMG, then drag Cortex into Applications. |
| Android arm64 | Signed APK | Open the APK and allow installation from the selected file source when Android asks. |

Linux AppImage builds require WebKitGTK and GTK at runtime. Ubuntu and Debian users can install the common runtime libraries with:

```bash
sudo apt-get install libwebkit2gtk-4.1-0 libgtk-3-0
```

Windows 10 and 11 normally include WebView2. If Cortex reports that WebView2 is missing, install the Microsoft Evergreen WebView2 runtime before launching the app. Release installers without an Authenticode certificate may also trigger a Microsoft Defender SmartScreen warning; review the publisher and release checksum before choosing to run one.

A macOS package without a Developer ID certificate is ad-hoc signed but not notarized. Gatekeeper may prevent the first normal double-click launch. Open Cortex once with Finder's **Open** action or approve it under **System Settings → Privacy & Security**. Ad-hoc signing verifies the bundle structure but does not establish a trusted publisher identity.

The Android APK is intended for arm64 devices and is distributed outside the Play Store. Android therefore asks for permission to install from the browser or file manager used to open it.

## Installing a server from the app

Choose **Install Cortex** on the first screen. The app automatically checks Node.js, npm, Git, and any existing Cortex installation, then installs or upgrades the server as needed. Node.js 20 or newer, npm, and Git must already be available. Missing prerequisites stop setup with instructions. If Node was installed through nvm and the app cannot see it, launch the app from a terminal so it inherits that shell's `PATH`.

Installation uses `npm install -g @cortex-agent/server@latest`; a supported existing installation is reused. Progress remains visible while commands run, and **Activity log** expands their output. Failures show the failing operation and a retry action.

Once installation is ready, enter the machine name and optionally enable auto-start or change the port under **Advanced settings**. PI is bundled with Cortex; this step does not ask you to choose backends. Clicking **Start Cortex** saves the configuration, starts the server, and connects. A new installation then opens provider setup at `/setup/providers` before entering the workbench.

For local development, launch the native app with `CORTEX_SETUP_SERVER_PACKAGE` set to an absolute path to a locally packed `.tgz`. The installer uses that package through npm and checks its reported version against the app's minimum. This does not publish the package; use an isolated home, npm prefix, credential store, and network for fresh-install testing.

The installation step asks nothing about Slack or Feishu: the app is the interface, and a server with no messaging platform runs on its built-in gateway. Provider login and the default profile are configured after the server connects.

A machine that already has a Cortex configuration keeps it. Setup enables or updates only the local connection endpoint; existing installations and connections do not automatically enter provider setup. Choosing **Install Cortex** also authorizes upgrading an installed server that is older than the app requires.

Because a local server has nothing else to start it, the app starts the daemon at launch whenever it is not already answering. Enabling autostart in the wizard additionally registers the service the server writes — a systemd user unit on Linux, a launchd agent on macOS — so scheduled tasks fire while the app is closed. Windows has no service registration, so the app's launch-time start is the only autostart there.

To enable the endpoint on an existing install without the wizard, run one command on the server:

```bash
cortex ui enable
```

This generates the client token if needed, sets `CORTEX_UI_HTTP` and `CORTEX_UI_PORT`, and adds the app's origins to `uiCorsOrigins`. Restart the daemon afterwards when it reports that the configuration changed. [Server configuration](#server-configuration) describes the same settings by hand.

## Provider setup

The provider setup page detects local credentials and offers a searchable list of PI providers. Detected credentials appear first. Choose a provider and a supported OAuth or API-key method to open the same login modal used by **Settings → Accounts**. PI needs no separate installation.

**Claude Code** is optional and separate from the Anthropic provider in PI. In local desktop setup, **Install and sign in** authorizes installing Claude Code on this computer, then opens its login flow. This is the only onboarding step that offers its installation. An existing Claude Code installation is reused.

Credential detection is not a live inference test: setup sends no paid inference request and does not prove that a model call will succeed. Missing, expired, or unknown credentials need attention even when the runtime is installed.

After login, the page refreshes credentials and synchronizes models and profiles. **Rescan and sync models** also picks up credentials configured elsewhere. Select an actual profile with a model and a matching configured account as the **Default profile**; a login alone is not enough to enable **Enter workbench**. If the current default does not match, choose an available profile explicitly. Existing profile definitions are preserved.

Choose **Enter workbench** when the configuration is ready, or **Set up later** to skip. The skip warning explains that the Agent may be unavailable until you finish **Settings → Accounts** and **Settings → Profiles**.

## Server configuration

The native shell talks to the server's opt-in Web UI endpoint. The endpoint itself is startup topology, so it stays in `$CORTEX_HOME/config/.env` on the server:

```bash
CORTEX_UI_HTTP=1
CORTEX_UI_PORT=3004
```

The allowed CORS origins are a runtime setting. Add or confirm the `uiCorsOrigins` key in `$CORTEX_HOME/config/settings.json` (see [configuration.md](./configuration.md#configsettingsjson)):

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

The legacy comma-separated `CORTEX_UI_CORS_ORIGINS` variable in `.env` is still read as a deprecated fallback.

`cortex init` generates `CORTEX_CLIENT_TOKEN` in `.env`. The native app uses that exact value; `CORTEX_TOKEN` is not the server-side client-token setting. Retrieve the configured token with:

```bash
grep CORTEX_CLIENT_TOKEN "${CORTEX_HOME:-$HOME/.cortex}/config/.env"
```

Restart the daemon after changing the endpoint in `.env`. A change to `uiCorsOrigins` needs no restart — it is resolved per request. A native app connects to an HTTP or HTTPS URL that reaches this endpoint. When the endpoint is exposed through a tunnel, use a hostname that accepts the Cortex token directly rather than one that requires an interactive browser SSO page.

Current builds serve the shell through the `cortexui` custom protocol, which appears as `cortexui://localhost` or `http://cortexui.localhost` depending on the WebView platform. The two `tauri` origins keep older native builds connectable. The server returns CORS headers only for origins explicitly listed in `uiCorsOrigins`.

## First connection

Choose **Connect an existing server** on the first screen, then enter the server URL, including `https://` or `http://`, together with `CORTEX_CLIENT_TOKEN`. The connection test distinguishes an unreachable endpoint from an unauthorized token. A successful connection opens the workbench and stores the credentials for later launches. A server installed by the wizard skips this screen — it connects with credentials it generated itself.

Linux, macOS, and Windows store the connection JSON in the operating-system keychain: Secret Service, Keychain, or Windows Credential Manager. Android stores it in the app's private data directory because the desktop keychain library has no Android backend. Disconnecting clears the platform store and returns to the connection screen.

## Desktop workbench

The desktop app uses the same three-pane workbench as the browser. The left rail lists projects and project-scoped sessions and links to the selected project's Overview. The center pane contains chat, streamed agent output, tool activity, attachments, question cards, and plan approvals. A slim rail along the chat's left edge marks every prompt in the session. The marks nearest the pointer stretch as it travels down the rail, the one under it previews what was asked, and clicking it scrolls the transcript back to that point. Marks stay lit for every turn the view currently shows, whether it holds the whole turn or only its head or tail. The right pane switches among Threads, Tasks, and Machines, shows today's project cost, and can be replaced by the private Notes pane.

Thread cards open a modal with the live pipeline, individual steps, nested threads, and the persisted artifact. Execution rows open a drawer with live logs and cancellation controls. `⌘K` on macOS or `Ctrl+K` on Linux and Windows opens the command palette.

### Plugin settings

**Settings → Plugins** inventories plugins installed on the connected Cortex server and assigns them to agent definitions or template slots. Each entry shows its portable or legacy format, manifest metadata, skills, validation issues, and a sanitized summary of portable root `mcp.json` servers. The desktop shell does not maintain a separate local catalog because it renders the same server-backed SPA as the browser (`web/src/features/settings/SettingsModal.tsx:81-112`; `web/src/features/settings/PluginsPanel.tsx:365-800`).

An ordinary template slot can use its agent defaults or customize a complete plugin snapshot. Shell bindings and `__active__` slots are read-only. Adding a portable plugin with at least one valid inventoried `mcp.json` server requires confirmation before save, and unsaved assignment edits block target navigation and closing the Settings modal. If server data changes during editing, the draft stays visible as stale and must be reset before saving. The page manages assignment only; administrators install, update, and remove package directories on the server. [Skills and Plugins](./skills-and-plugins.md) describes package formats, runtime behavior, and the trusted-code boundary.

To change servers, open the daemon or connectivity status, choose **Disconnect**, and enter the new endpoint and token on the connection screen.

## Android interface

Android uses four bottom tabs: Sessions, Threads, Tasks, and Project. Session chat, plan review, thread details, task details, approvals, issues, notes, memory files, machines, settings, hooks, and daemon status open as drill-in screens. The Android back action closes overlays first, then returns through the app's navigation stack.

With notification permission granted, **Settings → Notifications → Background notifications** enables an Android-owned connection that continues listening when the page is in the background. A silent ongoing notification shows the running direct-session count across projects, including background continuations. At zero it shows that background notifications are connected; while reconnecting it reports unavailable state rather than a stale count. Disabling this device-local switch or disconnecting stops the service and clears its notifications (`desktop/tauri-plugin-cortex-notifications/android/src/main/java/dev/cortex/notifications/NotificationService.kt`; `Reconciler.kt`).

Pending questions and plan approvals raise separate notifications. Session notifications open the related conversation, including from a cold launch. Approval-center entries open the approvals screen and select the entry. The native owner retains tap targets until the page handles them, and reconciles pending requests on reconnect and periodically. Notifications hide private content on the lock screen. The background connection requires HTTPS and is subject to Android Doze, manufacturer battery restrictions, network availability, and user force-stop; it is not a guarantee of delivery while the app is forcibly stopped. Pending question details currently require a Web-origin session channel (`NotificationsPlugin.kt`; `Protocol.kt`).

The background service also announces finished turns. Once a direct session's run reaches a completed state on the server and that session is no longer running, waiting for an answer, or holding a background task, the notification shows the session name and a short line inviting you to open it; no transcript text is fetched. Cancelled, failed, and still-waiting runs stay silent, and the session currently on screen raises nothing. The first connection to a server records the runs it finds without announcing them, so turning the feature on never replays old conversations. While the background service owns these notifications the page stops posting its own; with the device switch off, or on an app shell or cached page that predates them, the page's live feed keeps generating them (`Completions.kt`; `Reconciler.kt`; `web/src/mobile/v3/MNotificationProvider.tsx`).

Files downloaded by Cortex are handed to Android's `DownloadManager`, which writes them to the public Downloads collection and shows the system completion notification.

## Files and downloads

| Surface | Download behavior |
|---|---|
| Browser | Uses the browser's normal download manager. |
| Linux, macOS, Windows | Uses the operating system Downloads directory when available, falls back to app-local downloads, and offers **Open file** and **Open folder** actions after completion. |
| Android | Uses the system DownloadManager and public Downloads collection. |

The workbench previews images and videos, pages through PDFs, and displays text files without requiring a separate download. Desktop users can pin a preview beside chat while continuing the conversation.

## Versions and frontend updates

A tagged native release uses the same version as `@cortex-agent/server`. This shared CalVer identifies the server release and all native packages built from its tagged commit.

## Updates

The app uses two update channels, both coordinated by the connected server.

### Frontend workbench

After launch, the shell compares its installed SPA with the content-addressed frontend bundle served by the server. It downloads a newer bundle in the background, verifies its SHA-256 digest, stages it, and prompts when a restart can apply it. This channel updates the Web workbench without replacing the native executable or APK. Installing an Android APK with a different bundled frontend refreshes the local page once; subsequent launches preserve compatible frontend OTA updates. A cached legacy page without the native notification bridge falls back to the bundled page so notification taps remain usable (`desktop/src-tauri/src/seed.rs`).

### Native app shell

A server release can also carry native packages as GitHub Release assets. The server advertises the newest installable release that is not newer than its own version. The shell selects the asset matching its operating system, architecture, and package kind, downloads it directly from GitHub without forwarding the Cortex token, and verifies the GitHub-provided SHA-256 digest before offering it. The update dialog supports installing now, skipping that version, or postponing the decision.

| Platform | Native update behavior |
|---|---|
| Linux AppImage | Replaces the running AppImage in place, retains one `.old` backup, relaunches, and exits the old process. |
| Linux DEB or RPM | Copies the verified package to Downloads and opens the system package installer. |
| Windows | Launches the verified NSIS installer and exits so the installer can replace the app. |
| macOS | Copies the verified DMG to Downloads and opens it; installation finishes by dragging Cortex into Applications. |
| Android | Opens the system package installer over the verified APK; Android requests install-source permission when required. |

Running threads execute on the server, so restarting or reinstalling a client does not stop them. Native shell update checks are disabled when `CORTEX_FRONTEND_DIR` marks a development run, when the installed app does not carry a CalVer release version, or when `CORTEX_APP_UPDATE_DISABLE=1` is set.

## Troubleshooting

### Unauthorized

Confirm that the app contains the value of `CORTEX_CLIENT_TOKEN`, not the webhook token or a legacy variable. Re-enter the token after using Disconnect if the server token changed.

### Network error

Confirm that the daemon is running, `CORTEX_UI_HTTP=1` is loaded, the URL reaches the configured port, and the tunnel is active. A successful page load with failed API calls usually indicates a token or CORS problem. Confirm that the current `cortexui` origins are present in the `uiCorsOrigins` setting in `config/settings.json`; retain the `tauri` origins when older app builds also connect to the server.

### The wizard cannot find Node.js

A GUI launch inherits a reduced `PATH`, so a Node installed through nvm or a shell profile may be invisible to the app even though `node --version` works in a terminal. The wizard resolves the login shell's `PATH` and shows the one it used in the check step. If Node is still not found, launch the app once from a terminal so it inherits that environment, or install Node system-wide.

### The server does not answer after the wizard starts it

A cold start loads the whole agent runtime and can outlast the wizard's wait on a slow machine. The streamed log shows what the daemon reported. Check the state from a terminal:

```bash
cortex daemon status
cortex doctor
```

The app also starts a local server at launch, so reopening it retries.

### Credentials do not persist on Linux

A headless Linux environment may not provide a Secret Service daemon. In that case the keychain write fails and credentials last only for the current process. A local launch can seed the connection explicitly:

```bash
CORTEX_SERVER_URL=http://localhost:3004 CORTEX_TOKEN=<client-token> ./Cortex.AppImage
```

`CORTEX_TOKEN` in this launch command is a native-shell fallback variable; the server configuration remains `CORTEX_CLIENT_TOKEN`.

### App window does not open on Wayland

Tauri supports Wayland, but a system-specific WebKitGTK issue may require X11 compatibility:

```bash
GDK_BACKEND=x11 ./Cortex.AppImage
```
