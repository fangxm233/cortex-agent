# Desktop and Android Apps

Cortex provides a Tauri v2 native shell for Linux, macOS, Windows, and Android. The desktop shell presents the three-pane workbench; Android presents a phone-specific two-tab interface. Both connect directly to a Cortex server over the Web UI HTTP transport and use the same projects, sessions, approvals, files, and memory as the browser workbench.

The native apps require a reachable Web UI endpoint and the server's `CORTEX_CLIENT_TOKEN`. Browser access uses a separate Cloudflare Access path described in [Browser Access](browser-access.md).

The desktop app can either install a Cortex server on the computer it runs on or connect to one that already exists. The first screen asks which, and the local path needs no terminal: it installs the package, writes the configuration, starts the daemon, and connects. Android is remote-only, since it has no place to run a Node process.

Browser access uses a separate Cloudflare Access path described in [Browser Access](browser-access.md).

## Installation

For server releases that include native packages, download the platform asset from the [GitHub Releases page](https://github.com/fangxm233/cortex-agent/releases). The release policy assigns the native UI exactly the same CalVer as the corresponding server release: `YYYY.M.D[-N]`. The version embedded in the app and shown in the asset name must match the `server-v<version>` tag.

| Platform | Native release package | Installation |
|---|---|---|
| Linux x86_64 | AppImage, DEB, or RPM | Run the AppImage directly after `chmod +x`, or install the distribution package. |
| Windows x86_64 | NSIS `setup.exe` | Run the installer and launch Cortex from the Start menu. |
| macOS Apple Silicon | `macOS-aarch64` DMG | Open the DMG, then drag Cortex into Applications. |
| macOS Intel | `macOS-x86_64` DMG | Open the DMG, then drag Cortex into Applications. |
| Android arm64 | Signed APK | Open the APK and allow installation from the selected file source when Android asks. |

Linux AppImage builds require WebKitGTK and GTK at runtime. Ubuntu and Debian users can install the common runtime libraries with:

```bash
sudo apt-get install libwebkit2gtk-4.1-0 libgtk-3-0
```

Windows 10 and 11 normally include WebView2. If Cortex reports that WebView2 is missing, install the Microsoft Evergreen WebView2 runtime before launching the app. Release installers without an Authenticode certificate may also trigger a Microsoft Defender SmartScreen warning; review the publisher and release checksum before choosing to run one.

A macOS package without a Developer ID certificate is ad-hoc signed but not notarized. Gatekeeper may prevent the first normal double-click launch. Open Cortex once with Finder's **Open** action or approve it under **System Settings → Privacy & Security**. Ad-hoc signing verifies the bundle structure but does not establish a trusted publisher identity.

The Android APK is intended for arm64 devices and is distributed outside the Play Store. Android therefore asks for permission to install from the browser or file manager used to open it.

## Installing a server from the app

Choose **Install Cortex** on the first screen and wait for installation to finish. Setup needs no terminal, Homebrew, Command Line Tools, or administrator access. Progress stays brief; **Activity log** is a folded troubleshooting entry. If installation fails, follow the message and choose **Try again**. **Cancel** during installation stops the active installation step, not an existing server; it does not undo files already installed.

Each desktop installer carries the runtime the local server needs: the official Node.js 24 build for its platform and, on Windows, Git for Windows (PortableGit) with Git Bash. Setup unpacks them into versioned directories under `~/.cortex/runtime`, then uses that npm to install the Cortex server package into the private prefix `~/.cortex/runtime/prefix`. Only the server package, and Claude Code when you choose to install it, come from the npm registry; npm follows your `.npmrc` registry, proxy, and credential settings. Setup does not change global npm settings, shell profiles, or the system `PATH`, and it neither uses nor modifies a Node.js, npm, Git, or `cortex` already installed on the computer.

The local server always runs on the bundled runtime. When a runtime directory is missing or damaged, the app unpacks it again during setup, or at launch before it starts the daemon. A saved server installation that no longer runs, or is older than the app requires, is reinstalled into the private prefix. On Windows, Cortex runs shell commands with the bundled Git Bash. On macOS and Linux, Git is optional and setup does not install it; Git-based history and Git-sourced extensions require it.

The bundled Node.js determines where local installation works: macOS 13.5 or later, Linux x86_64 with glibc 2.28 or later, and Windows 10 or 11 on x86_64. On other systems the app can still connect to an existing server.

Installation continues automatically through initialization, server startup, and connection. A new installation uses this computer's hostname, port 3004, and no login service. There is no machine-settings page or **Start Cortex** confirmation on this path. Progress remains one installation row, with technical details in **Activity log**. A new installation opens provider setup at `/setup/providers` for login and a default profile before entering the workbench. PI is bundled with Cortex; setup does not ask you to choose backends.

If initialization, startup, or connection fails, **Try again** reuses the original setup choices. **Edit settings** opens the repair form; starting from this form can restart the local server to apply an explicitly selected port. Automatic setup preserves a responding server. Installation failures offer retry, not machine settings.

Local setup belongs to the native app and the setup page bundled with it; updating the Web frontend or replacing `web/dist` does not change it.

For local development, launch the native app with `CORTEX_SETUP_SERVER_PACKAGE` set to an absolute path to a locally packed `.tgz`. The installer uses that package through npm and checks its reported version against the app's minimum. This does not publish the package; use an isolated home, npm prefix, credential store, and network for fresh-install testing.

The installation step asks nothing about Slack or Feishu: the app is the interface, and a server with no messaging platform runs on its built-in gateway. Provider login and the default profile are configured after the server connects.

A machine that already has a Cortex configuration keeps its machine identity and service settings. Automatic setup enables the local connection endpoint without overriding its configured port or running initialization again. It checks the saved installation even when it is already usable, so later launches use the same runtime. Existing installations and connections open the workbench unless a new local installation still has unfinished provider setup.

The app starts the local daemon at launch whenever it is not already answering. Automatic setup does not create or change a login service. If initialization needs repair, the new-install settings form offers **Start at login**: the native app writes and registers a systemd user unit on Linux or a launchd agent on macOS, so scheduled tasks can fire while the app is closed. Registration takes effect at the next login and does not replace the daemon already running. Existing service settings are preserved. Windows has no service registration, so the app's launch-time start is the only autostart there.

To enable the endpoint on an existing install without the wizard, run one command on the server:

```bash
cortex ui enable
```

This generates the client token if needed, sets `CORTEX_UI_HTTP` and `CORTEX_UI_PORT`, and adds the app's origins to `uiCorsOrigins`. Restart the daemon afterwards when it reports that the configuration changed. [Server configuration](#server-configuration) describes the same settings by hand.

## Provider setup

The provider setup page detects local credentials and offers a searchable list of PI providers. Detected credentials appear first. Choose a provider and a supported OAuth or API-key method to open the same login modal used by **Settings → Accounts**. PI needs no separate installation. OAuth may open your browser and require authorization or MFA; login is not guaranteed to stay inside the app.

**Claude Code** is optional and separate from the Anthropic provider in PI. In local desktop setup, **Install and sign in** authorizes installing Claude Code on this computer, then opens its login flow. This is the only onboarding step that offers its installation. An existing Claude Code installation is reused.

Credential detection is not a live inference test: setup sends no paid inference request and does not prove that a model call will succeed. Missing, expired, or unknown credentials need attention even when the runtime is installed.

After login, the page refreshes credentials and synchronizes models and profiles. **Rescan and sync models** also picks up credentials configured elsewhere. The first sync with a signed-in provider creates the `plan` and `execute` profiles from that provider's recommended model — for PI providers, the model PI itself starts with, such as `gpt-5.5` for OpenAI (ChatGPT Plus/Pro). Providers you have not signed in to contribute no profiles. Select an actual profile with a model and a matching configured account as the **Default profile**; a login alone is not enough to enable **Enter workbench**. If the current default does not match, choose an available profile explicitly. Existing profile definitions are preserved.

The optional **Public usage leaderboard** card puts your token usage on the public [aistatus.cc leaderboard](https://aistatus.cc/leaderboard), which shows your name, organization, and token counts. It is off unless you have already joined. Switch it on, enter a name and an email (the organization is optional), and choose **Save**; the email only identifies you and is never displayed. The card does not affect **Enter workbench** or **Set up later**, and the same card stays available under **Settings → Usage**.

Choose **Enter workbench** when the configuration is ready, or **Set up later** to skip. The skip warning explains that the Agent may be unavailable until you finish **Settings → Accounts** and **Settings → Profiles**.

After a new local installation connects, quitting on this page and reopening the app resumes provider setup—even if you have not signed in. Login alone does not finish setup. **Enter workbench** and deliberate **Set up later** save your choice before leaving, so later launches open the workbench. If saving fails, stay on this page and try again. Older unmarked installations and remote connections keep their usual startup behavior.

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

The desktop app uses the same workbench as the browser. The left rail lists projects and project-scoped sessions and links to the selected project's Overview. The center pane contains chat, streamed agent output, tool activity, attachments, question cards, and plan approvals. A slim rail along the chat's left edge marks every prompt in the session. The marks nearest the pointer stretch as it travels down the rail, the one under it previews what was asked, and clicking it scrolls the transcript back to that point. Marks stay lit for every turn the view currently shows, whether it holds the whole turn or only its head or tail. The machines chip in the top bar shows how many machines are online; clicking it opens a sheet with each machine's GPU and host details. The Notes button in the chat header (⌘⇧N) opens the private notes as a card beneath it, leaving the composer in view. Directly above the composer, one row of capsules shows what the session is doing: the agent's task list, as a progress ring with the current item, and anything it waits on outside Cortex. The task capsule stays while the list has open items and leaves once a finished list's turn ends. Each capsule opens its detail as a popover, so the composer never moves. On a phone the same row also carries the lead's team and the bound board, and each capsule opens a sheet.

Consecutive tool calls collapse into one row that counts them and names their tools. Calls whose result returned images — `Read` on an image file, PI's `read`, `remote_read`, or any MCP tool that answers with an image — form rows of their own, labelled *Read N images*: consecutive image reads share one row, and rows keep the order the calls ran in, so reads interleaved with other tools alternate with them. Expanding it lists each of those calls with its images beneath it, at most 120 px high; clicking an image opens it in the media viewer. A read call's image carries the name of the file it read. The row shows only what the model received: a PI model that takes no image input is never sent a tool's images, so its calls stay in the ordinary row. Mobile chat and subagent blocks show the same rows. The images are kept under `$CORTEX_HOME/tmp/tool-images/<session id>/`.

The chat header's **⋯** menu offers **Star / Unstar** and **Rename** on desktop and mobile. In the desktop session list, hovering a row replaces its time with the same actions under **⋯**, without opening that conversation; the control is also available by keyboard focus. Each project's session list has a collapsible **Stars** section; starring moves a session there, and unstarring returns it to its ordinary group. Empty Stars sections are hidden. Names and stars are saved on the server. Rename changes only the display title, not either session ID, and accepts a nonblank title of up to 60 characters.

Execution rows on a project's Overview open a drawer with live logs and cancellation controls. `⌘K` on macOS or `Ctrl+K` on Linux and Windows opens the command palette.

Code blocks in chat show a copy button while the pointer is over them; on touch screens the button stays visible. On Windows, text copied in the app with `Ctrl+C`, the context menu, or a copy button appears in Clipboard History (`Win+V`) like a copy from any other application. WebView2 writes these copies from its own browser process, which Windows leaves out of the history, so the app shell writes the same data back under its own window. Content its writer marks as excluded from history stays excluded (`desktop/src-tauri/src/clipboard_history.rs`).

### Plugin settings

**Settings → Plugins** inventories plugins installed on the connected Cortex server. Each entry shows its portable or legacy format, manifest metadata, skills, validation issues, the environments that use it, and a sanitized summary of portable root `mcp.json` servers. The desktop shell does not maintain a separate local catalog because it renders the same server-backed SPA as the browser (`web/src/features/settings/SettingsModal.tsx`; `web/src/features/settings/panels/PluginsPanel.tsx`).

**Settings → Environments** edits the [execution environments](./configuration.md#execution-environments), and each environment's Plugins tab assigns plugins to it. Adding a portable plugin with at least one valid inventoried `mcp.json` server requires confirmation before save, and unsaved assignment edits block navigation and closing the Settings modal. If server data changes during editing, the draft stays visible as stale and must be reset before saving. Administrators install and update package directories on the server. [Skills and Plugins](./skills-and-plugins.md) describes package formats, runtime behavior, and the trusted-code boundary.

To change servers, open the daemon or connectivity status, choose **Disconnect**, and enter the new endpoint and token on the connection screen.

## Desktop and browser notifications

**Settings → Notifications → System notifications** controls notifications on this device and defaults to on. Browser permission is separate: click **Allow notifications** to grant it. Browsers require HTTPS or localhost and a supported Notifications API; a denied permission must be changed in the browser's site settings.

While the desktop app or browser page is running and connected, completed replies and system notices use operating-system notifications when the window is hidden or unfocused. In the foreground, Cortex keeps its in-app notifications and suppresses replies for the conversation being viewed. Team workers' replies raise neither; their lead's reply does ([Team Mode](team.md)). Disabling system notifications, missing permission, or a delivery error leaves the in-app notifications available.

Clicking a session notification restores/focuses the app or browser page and opens that conversation. A system notice without a conversation only focuses the window. Desktop click routing requires the native notification bridge in the installed app; a frontend update alone cannot add it to an older shell. Switching servers invalidates pending desktop notification targets.

Desktop and browser notifications require the app or page to remain running; closing it stops delivery. Browser tabs receive events independently. System notification settings, Do Not Disturb, and Linux notification-server/window-manager support can restrict display, click actions, or focus. Some mobile browsers do not support page-created notifications and keep the in-app fallback. Android has its own background service, described below.

## Android interface

The Android home screen is the current project's session list. Swiping right anywhere on the list slides in the Projects panel from the left: the current project's budget, approvals, issues, notes and memory, the other projects to switch to, and the usage and settings buttons. The panel follows your finger and opens or closes depending on how far or how fast you swipe. A mostly vertical swipe scrolls the list. Swiping left, tapping the dimmed list, or pressing Back closes the panel. The Cortex mark in the top-left corner also opens the panel, and it shows an amber count while approvals are waiting for you. Session chat, plan review, approvals, issues, notes, memory files, machines, settings, hooks, and daemon status open as drill-in screens, and Back from a screen opened in the panel returns to the open panel. The Android back action closes overlays first, then returns through the app's navigation stack.

With notification permission granted, **Settings → Notifications → Background notifications** enables an Android-owned connection that continues listening when the page is in the background. A silent ongoing notification shows the running direct-session count across projects, including background continuations. At zero it shows that background notifications are connected; while reconnecting it reports unavailable state rather than a stale count. Disabling this device-local switch or disconnecting stops the service and clears its notifications (`desktop/tauri-plugin-cortex-notifications/android/src/main/java/dev/cortex/notifications/NotificationService.kt`; `Reconciler.kt`).

Pending questions and plan approvals raise separate notifications. Session notifications open the related conversation, including from a cold launch. Approval-center entries open the approvals screen and select the entry. The native owner retains tap targets until the page handles them, and reconciles pending requests on reconnect and periodically. Notifications hide private content on the lock screen. The background connection requires HTTPS and is subject to Android Doze, manufacturer battery restrictions, network availability, and user force-stop; it is not a guarantee of delivery while the app is forcibly stopped. Pending question details currently require a Web-origin session channel (`NotificationsPlugin.kt`; `Protocol.kt`).

The background service also announces finished turns. Once a direct session's run reaches a completed state on the server and that session is no longer running, waiting for an answer, or holding a background task, the notification shows the session label (or a short session ID) and a short line inviting you to open it; no transcript text is fetched. Cancelled, failed, and still-waiting runs stay silent, as do team workers' runs, and the session currently on screen raises nothing. The first connection to a server records the runs it finds without announcing them, so turning the feature on never replays old conversations. While the background service owns these notifications the page stops posting its own; with the device switch off, or on an app shell or cached page that predates them, the page's live feed keeps generating them (`Completions.kt`; `Reconciler.kt`; `web/src/mobile/screens/MNotificationMount.tsx`).

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

**Help → Check for updates** (or **Settings → Check for updates** on Android) checks the connected server for a fresh release, then checks the frontend workbench and native app shell. Repeated clicks share the running check. Results distinguish available, current, skipped, and failed checks; disabled checks, development runs, and skipped versions are not reported as current.

Update prompts are ordered: server first, native app next, then the frontend workbench. With `serverAutoUpdate` on (the default), a newer server release is installed without a prompt once no task is running, and the server then restarts; only a failed install raises the dialog. With it off, checking does not authorize installation or a restart: **Update** on the server prompt authorizes them, and they wait until no task is running; **Later** hides the prompt until another manual check, while **Skip this version** retains the skipped-version policy. Server checks respect `serverUpdateDisable` and development mode.

After the server reconnects, the app checks only its frontend and native channels again. Each restart or installer keeps its own confirmation and platform permissions: this is an ordered flow, not an atomic installation of all components. Browsers use a [page refresh confirmation](browser-access.md#updates) rather than native installers.

### Frontend workbench

After launch, the shell compares its installed SPA with the content-addressed frontend bundle served by the server. It downloads a newer bundle in the background, verifies its SHA-256 digest, stages it, and prompts when a restart can apply it. This channel updates the Web workbench without replacing the native executable or APK. Installing an Android APK with a different bundled frontend refreshes the local page once; subsequent launches preserve compatible frontend OTA updates. A cached legacy page without the native notification bridge falls back to the bundled page so notification taps remain usable (`desktop/src-tauri/src/seed.rs`). While no server is connected, the shell serves the frontend bundled with the app instead of the downloaded one, so the connection and setup screens always match the installed app, whichever server's bundle is on the device (`desktop/src-tauri/src/frontend.rs`).

### Native app shell

A server release can also carry native packages as GitHub Release assets. The server advertises the newest installable release that is not newer than its own version. The shell selects the asset matching its operating system, architecture, and package kind, downloads it directly from GitHub without forwarding the Cortex token, and verifies the GitHub-provided SHA-256 digest before offering it. The update dialog supports installing now, skipping that version, or postponing the decision.

| Platform | Native update behavior |
|---|---|
| Linux AppImage | Replaces the running AppImage in place, retains one `.old` backup, relaunches, and exits the old process. |
| Linux DEB or RPM | Copies the verified package to Downloads and opens the system package installer. |
| Windows | Launches the verified NSIS installer and exits so the installer can replace the app. |
| macOS | Copies the verified DMG to Downloads and opens it; installation finishes by dragging Cortex into Applications. |
| Android | Opens the system package installer over the verified APK; Android requests install-source permission when required. |

Sessions run on the server, so restarting or reinstalling a client does not stop them. Native shell update checks are disabled when `CORTEX_FRONTEND_DIR` marks a development run, when the installed app does not carry a CalVer release version, or when `CORTEX_APP_UPDATE_DISABLE=1` is set.

## Troubleshooting

### Unauthorized

Confirm that the app contains the value of `CORTEX_CLIENT_TOKEN`, not the webhook token or a legacy variable. Re-enter the token after using Disconnect if the server token changed.

### Network error

Confirm that the daemon is running, `CORTEX_UI_HTTP=1` is loaded, the URL reaches the configured port, and the tunnel is active. A successful page load with failed API calls usually indicates a token or CORS problem. Confirm that the current `cortexui` origins are present in the `uiCorsOrigins` setting in `config/settings.json`; retain the `tauri` origins when older app builds also connect to the server.

### Local installation cannot finish {#the-wizard-cannot-find-nodejs}

Choose **Try again** first: setup unpacks missing runtime files again and reinstalls a server that cannot run. When the server package cannot be downloaded, check the network connection and the registry and proxy settings in `.npmrc`. If the app reports that it is incomplete, download the installer for your platform again and reinstall it. An unsupported system can connect to a server on another computer instead. Open **Activity log** only when you need diagnostic details.

### The server does not answer after the wizard starts it

A cold start loads the whole agent runtime and can outlast the wizard's wait on a slow machine. The streamed log shows what the daemon reported. Check the state from a terminal:

The app-private CLI is not added to your terminal's PATH. On Linux/macOS:

```bash
~/.cortex/runtime/prefix/bin/cortex daemon status
~/.cortex/runtime/prefix/bin/cortex doctor
```

These commands need Node on PATH. If it is absent, use the absolute `node` path
recorded in `~/.cortex/runtime/selection.json` to invoke the CLI:
`"<node path>" ~/.cortex/runtime/prefix/bin/cortex doctor` (or `daemon status`).

On Windows, use PowerShell with the saved runtime, without needing Node on PATH:

```powershell
$runtime = Get-Content "$env:USERPROFILE\.cortex\runtime\selection.json" -Raw | ConvertFrom-Json
& $runtime.node "$env:USERPROFILE\.cortex\runtime\prefix\node_modules\@cortex-agent\server\dist\entry\cortex-cli.js" daemon status
& $runtime.node "$env:USERPROFILE\.cortex\runtime\prefix\node_modules\@cortex-agent\server\dist\entry\cortex-cli.js" doctor
```

If you set `CORTEX_HOME`, substitute that directory for `~/.cortex` or
`$env:USERPROFILE\.cortex` in these paths.

The app also starts a local server at launch, so reopening it retries.

### Credentials do not persist on Linux

A headless Linux environment may not provide a Secret Service daemon. Fresh local
setup cannot finish until it can save credentials; ordinary connections fall back
to credentials that last only for the current process. Enable the system keyring,
or launch the app with an explicit connection to the running server:


```bash
CORTEX_SERVER_URL=http://localhost:3004 CORTEX_TOKEN='<client-token>' ./Cortex.AppImage
```

Use the value of `CORTEX_CLIENT_TOKEN` in `$CORTEX_HOME/config/.env` (default `~/.cortex/config/.env`) as `<client-token>`. `CORTEX_TOKEN` is the native-shell fallback variable; it does not replace the server setting. This fallback connects to an already-running server and does not start it automatically.

### App window does not open on Wayland

Tauri supports Wayland, but a system-specific WebKitGTK issue may require X11 compatibility:

```bash
GDK_BACKEND=x11 ./Cortex.AppImage
```
