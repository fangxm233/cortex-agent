Please update me when files in this folder change

Cortex Desktop / Mobile — Tauri v2 shell that wraps the built web SPA in a native app.
Targets **desktop** (Linux/macOS/Windows, native window) and **Android** (mobile bottom-Tab shell)
from one Rust crate + one `web/dist`. Platform differences are `cfg`-gated in `src/lib.rs`
(see "## Android platform" below).
Serves the SPA over a custom `cortexui://` URI scheme from a swappable frontend directory
(so the frontend can self-update — see "Frontend OTA" below) instead of the built-in read-only
asset protocol. The SPA talks directly to the remote Cortex server using absolute URLs — token
injection is handled by `web/src/lib/trpc.ts` (conditional transport) and wired up by
`web/src/providers.tsx` reading `window.__CORTEX_DESKTOP_CONFIG`.

## Frontend OTA (self-updating SPA)

The window loads `cortexui://localhost/<index|connect>.html`. A registered URI-scheme handler
(`register_uri_scheme_protocol("cortexui", …)`) serves each request from the **active frontend
directory**, resolved newest-first by `active_frontend_dir`:
1. `CORTEX_FRONTEND_DIR` env override (dev/testing — point straight at `web/dist`).
2. OTA-downloaded current version: `<appDataDir>/ui/current` (populated by the updater, `ota.rs`).
3. Bundled seed shipped with the app (first-run / offline fallback): desktop reads it from
   `<resourceDir>/frontend-seed` (real files staged by `bundle.resources` mapping `../../web/dist/`
   → `frontend-seed/` in tauri.conf.json); **Android** has no std::fs-readable resource seed, so it
   embeds `web/dist` with `include_dir!` (`seed.rs`) and materializes it into `ui/current` on first
   run — after which the same disk resolver + OTA path apply.

This runs on **both desktop and Android**. `frontend.rs` holds the pure resolver (`resolve_asset`):
percent-decode + path-traversal guard + MIME + SPA fallback to index.html, mirroring the server's
`serveSpaStub`. Native `std::fs` read — no JS fs-plugin capability needed. A single origin
(`cortexui://`) is kept for the SPA's whole life so browser-origin state is stable across seed→OTA
swaps. OTA hot-updates only the SPA; changes to the Rust shell still require an APK/app rebuild.

⚠️ **`connect.html` is served from a binary-embedded copy, NOT the frontend dir.** The scheme handler
calls `frontend::resolve_embedded` first: any request for `connect.html` returns an `include_str!`-baked
copy (source of truth `desktop/ui/connect.html`), bypassing the on-disk frontend dir; every other path
falls through to `resolve_asset`. This is load-bearing: `connect.html` is a shell-local page and is
**not** part of the server-delivered OTA bundle (the server only builds the SPA). Once an OTA frontend
(or any bundle without connect.html) is the active dir, resolving connect.html from disk fails and
SPA-falls-back to `index.html` — a workbench with no server config → blank "can't connect", and the app
is **bricked after a disconnect** (which navigates to connect.html). Embedding removes that whole class
of failure and keeps the connection screen reachable regardless of seed/OTA state, on both platforms.

The server side (agent-server `platform/ui-http/ui-ota.ts`) exposes the matching
`/api/ui-ota/manifest.json` + `/api/ui-ota/bundle.zip` (token-gated).

**Hot-update prompt (design 21a / mobile 3a):** when the background `check_and_stage` stages a bundle,
the shell emits the `frontend-update-staged` event to the SPA (payload = `ota::StagedUpdate`
`{version, fromVersion, size}`) so it can raise the "新版本已就绪" prompt (`web/src/features/hot-update`).
The prompt's primary button invokes `apply_frontend_update` — **desktop `app.restart()`** (relaunch →
startup `promote_staged` applies), **Android `app.exit(0)`** (system relaunch applies). `get_staged_update`
returns any currently-staged update as a backstop for a missed event (size not persisted → 0). Applying
never interrupts work: threads execute server-side, not in the app.

⚠️ **CORS origin change**: the webview Origin is now `cortexui://localhost` (Linux/macOS) or
`http://cortexui.localhost` (Windows), not `tauri://localhost`. The remote server's
`CORTEX_UI_CORS_ORIGINS` must list these new origins or the SPA's cross-origin tRPC calls are
blocked by the browser.

## First-run / connection flow

1. **No stored credentials** → Tauri opens `connect.html` (the connection config screen).
   User enters `serverUrl` + `clientToken`, clicks Test (probe), then Connect.
   JS calls the `connect` Tauri command → OS keychain save + AppState update.
   Page navigates to `index.html` (SPA workbench).

2. **Credentials in keychain** → Rust loads them at startup, opens `index.html` directly.
   `initialization_script` (injected on every page) **bakes the loaded credentials straight into
   the script synchronously** as the initial `window.__CORTEX_DESKTOP_CONFIG` (see `init_script(&config)`
   in `lib.rs`), so the SPA sees them before any bundle code runs. An async `get_connection_config`
   IPC call still runs as a refresh (covers the first-run connect flow, where the window was built
   before the user saved creds). `providers.tsx` reads `window.__CORTEX_DESKTOP_CONFIG` and passes it
   to `createTrpcClient()`.

   ⚠️ **Why baked, not IPC-only** (regression fixed): the old code seeded the config *only* via the
   async IPC and `providers.tsx` read it *exactly once* at React mount. On Android's **second launch**
   the WebView serves a code-cached bundle that mounts React faster than the IPC round-trip resolves,
   so the SPA captured the stale `{serverUrl:null}` and built a dead tRPC client — the mobile shell
   rendered (bottom Tab bar) but every data screen failed, i.e. "only the bottom bar shows". Baking
   the creds synchronously + `providers.tsx` waiting for them in native shell (`useShellConfig`)
   removes the race.

3. **Switch / disconnect** → hover the "Switch" button (injected by `initialization_script`)
   → calls `disconnect` command (clears keychain + AppState) → navigates to `connect.html`.

## Package layout

```
desktop/
├── package.json              pnpm package: @tauri-apps/cli devDep, @tauri-apps/api dep
│                             scripts: copy-connect / dev / build
├── ui/
│   └── connect.html          Standalone connection config screen, in the SPA's design language:
│                             theme-aware (light default / dark, follows persisted `cortex.theme` +
│                             OS via a no-flash script; tokens mirror web/src/index.css), system-sans
│                             body + IBM Plex Mono for the logo/inputs, ink-solid primary button.
│                             Top-right EN/中 language toggle (1:1 with the SPA left rail, persisted to
│                             `cortex.lang`) localizes the whole screen. Both keys are shared with the
│                             SPA so a choice here matches the workbench. RESPONSIVE: when the shell
│                             injects `__CORTEX_MOBILE__` (Android) it adds `.mobile` to <html> and
│                             switches to a full-bleed mobile layout (scheme-mobile `--m-*` surfaces,
│                             big-title header, 16px inputs, full-width stacked buttons, safe-area
│                             insets); desktop keeps the centered card. Served from the binary embed
│                             (frontend::resolve_embedded); also copied to web/dist by `copy-connect`.
├── src-tauri/
│   ├── Cargo.toml            cortex-desktop crate (tauri v2 + serde + reqwest[rustls]/sha2/zip; keyring v3 desktop-only, include_dir android-only)
│   ├── build.rs              tauri-build entry point
│   ├── tauri.conf.json       Tauri config: frontendDist=../../web/dist, withGlobalTauri
│   ├── capabilities/
│   │   └── default.json      Security capability (core:default)
│   ├── icons/                Placeholder icons
│   └── src/
│       ├── main.rs           Rust entry point (calls lib::run)
│       ├── lib.rs            AppState + 4 Tauri commands + init_script (SHELL_FLAG per platform) +
│       │                     active_frontend_dir + cortexui:// scheme (both platforms) + run()
│       ├── creds.rs          Platform-branched credential store: OS keychain (desktop) / app-private file (android)
│       ├── frontend.rs       Pure OTA asset resolver (both platforms; resolve_asset: sanitize/traversal/MIME/SPA-fallback)
│       ├── ota.rs            Frontend OTA updater (both platforms; reqwest[rustls]/sha2/zip)
│       └── seed.rs           Android-only: include_dir!-embedded web/dist seed → ui/current on first run
├── src-tauri/gen/android/    Generated Android Gradle project (gitignored; `tauri android init`)
└── src-tauri/target/         Rust build output (gitignored)
```

## Plugins

- `tauri-plugin-notification` (Cargo.toml + `.plugin(tauri_plugin_notification::init())` in `lib.rs`;
  `notification:default` in `capabilities/default.json`): native OS/system notifications for the SPA
  (design 1q). The Android System WebView has no web Notifications API, so the mobile shell's
  notifications go through this plugin. JS side: `@tauri-apps/plugin-notification`, called from
  `web/src/features/notifications/os-notify.ts`. Android's `POST_NOTIFICATIONS` runtime permission is
  requested by the SPA on mount (`MNotificationProvider`) via the plugin's `requestPermission`.

## Tauri commands

| command | signature | purpose |
|---|---|---|
| `get_connection_config` | `() → ConnectionConfig` | Read current AppState credentials |
| `set_connection_config` | `(serverUrl?, token?) → void` | In-memory update (legacy; prefer `connect`) |
| `connect` | `(serverUrl, token) → Result<()>` | Save to OS keychain + update AppState |
| `disconnect` | `() → Result<()>` | Clear keychain + AppState |
| `apply_frontend_update` | `() → ()` | Apply a staged frontend update — desktop `app.restart()`, Android `app.exit(0)` (hot-update prompt primary button) |
| `get_staged_update` | `() → Option<StagedUpdate>` | Currently-staged update (`{version, fromVersion, size:0}`) as a backstop for a missed `frontend-update-staged` event |
| `save_download` | `(name, bytes) → Result<String>` | Save agent-sent / user-downloaded file bytes to disk (the SPA fetches bytes then invokes this, because a browser `<a download>` / `window.open(blob)` is a no-op in the WebView). Basename-sanitized (no path escape), ` (n)`-suffixed on collision. **Desktop** → OS download dir (`download_dir()`, fallback `app_data_dir/downloads`); **Android** → `app_data_dir/downloads` (app-private, reachable under `Android/data/dev.cortex.desktop/`) + a system notification. Returns the saved absolute path. No new plugin/capability — an app command using `std::fs` + the core path API. Public Android Downloads (MediaStore/DownloadManager) is a documented follow-up. |

## Injection mechanism

`initialization_script` (built by `init_script(&config)` in `lib.rs`, injected on every page load):
1. Sets `window.__CORTEX_DESKTOP__ = true` (or `__CORTEX_MOBILE__` on Android) — synchronous
2. Sets `window.__CORTEX_DESKTOP_CONFIG = {serverUrl, token}` from the **baked-in** credentials —
   synchronous (present before any bundle code runs)
3. Starts async `invoke('get_connection_config')` → refreshes `window.__CORTEX_DESKTOP_CONFIG`
   (matters only on the first-run connect flow, where the baked value was still null)
4. On DOMContentLoaded: if NOT on `connect.html` and NOT mobile, adds a "Switch" button (bottom-right)

`web/src/providers.tsx` resolves `window.__CORTEX_DESKTOP_CONFIG` via `useShellConfig()` (reads it
synchronously; in a native shell without a config yet, briefly polls for the IPC refresh before
falling back) and passes it to `createTrpcClient()` — enabling absolute-URL + token-bearer mode.

## Files

| filename | role | function |
|---|---|---|
| `ui/connect.html` | connect screen | Standalone HTML/CSS/JS in the SPA design language (theme-aware via `cortex.theme` + tokens from index.css; EN/中 toggle persisted to `cortex.lang`) — serverUrl+token inputs, Test probe, Connect (keychain), Switch link |
| `src-tauri/src/lib.rs` | core | `AppState`, `ConnectionConfig`, 4 Tauri commands, `init_script()` + `SHELL_FLAG` (per-platform), `active_frontend_dir`, `cortexui://` scheme (both platforms), `run()` |
| `src-tauri/src/creds.rs` | credential store | Platform-branched `load`/`save`/`clear` — OS keychain (desktop) / app-private JSON in `app_data_dir` (android) |
| `src-tauri/src/frontend.rs` | OTA resolver | Pure `resolve_asset`/`sanitize_request_path`/`content_type` (traversal guard + MIME + SPA fallback) + `resolve_embedded` (serves the `include_str!`-baked `connect.html` so the connect screen never depends on the on-disk/OTA frontend); unit-tested |
| `src-tauri/src/ota.rs` | OTA updater | `UiStore` (current/staged promote), `check_and_stage`, sha256 verify, zip extract; reqwest[rustls]; unit-tested |
| `src-tauri/src/seed.rs` | android seed | `ensure_seed` — `include_dir!`-embedded `web/dist`, extracted into `ui/current` on first run (Android only) |
| `src-tauri/src/main.rs` | entry | `#[cfg_attr windows_subsystem]` + `lib::run()` |
| `src-tauri/Cargo.toml` | manifest | `cortex-desktop` crate; tauri v2 + serde + keyring v3 |
| `src-tauri/build.rs` | build | `tauri_build::build()` |
| `src-tauri/tauri.conf.json` | config | `frontendDist: ../../web/dist`, `withGlobalTauri: true` |
| `src-tauri/capabilities/default.json` | security | `core:default` capability |
| `src-tauri/icons/` | assets | Placeholder icons |

## Config env vars (dev / testing)

| Variable | Purpose |
|---|---|
| `CORTEX_SERVER_URL` | Pre-seed serverUrl at startup (bypasses keychain, skips connect screen) |
| `CORTEX_TOKEN` | Pre-seed token at startup (bypasses keychain) |
| `CORTEX_FRONTEND_DIR` | Serve the SPA from this directory (highest priority in `active_frontend_dir`) — dev/testing without bundling a seed or downloading an OTA version |

## Scripts (from `desktop/` directory)

| Script | Command | What it does |
|---|---|---|
| `copy-connect` | `node -e "fs.mkdirSync('../web/dist',{recursive:true}); fs.copyFileSync('ui/connect.html','../web/dist/connect.html')"` | Stage connect screen into web/dist (cross-platform node one-liner — the old `mkdir -p && cp` shell form failed on Windows cmd.exe) |
| `dev` | `npm run copy-connect && tauri dev` | Copy connect.html + launch Tauri dev window |
| `build` | `npm run copy-connect && tauri build` | Copy connect.html + produce app bundle |

## System prerequisites (Linux)

```
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

**Build order:** `pnpm --filter web build` → `pnpm --filter desktop build` (or `dev`).
The `copy-connect` step runs automatically as part of `dev`/`build`.

## Android platform

The same crate builds an Android app. The frontend transport + OTA are now shared (both platforms
serve over `cortexui://` from disk and self-update); only a few platform seams differ, `cfg`-gated
in `lib.rs` on `target_os = "android"`:

| Concern | Desktop | Android |
|---|---|---|
| Frontend transport | custom `cortexui://` scheme reading from disk (`frontend.rs` + OTA) | same custom `cortexui://` scheme + `frontend.rs` resolver reading from disk. `app_data_dir()` is a real writable dir on Android (as `creds.rs` already proves), so `ui/current` + `ui/staged` work identically. |
| Frontend OTA | on (reqwest/sha2/zip) | **on** — same updater. reqwest uses the rustls backend with the **ring** crypto provider; the OTA client is built with an explicit rustls `ClientConfig` pinned to the **webpki-roots** trust anchors (`ota::build_http_client` + `use_preconfigured_tls`) so it cross-compiles without OpenSSL / the OS trust store. This is **load-bearing**: reqwest 0.13 otherwise defaults to `rustls-platform-verifier`, which SIGABRTs on Android ("Expect rustls-platform-verifier to be initialized") because it needs a JNI-initialized OS trust store — a `panic=abort` release build turns that into a full-process crash. Only the **first-run seed** differs (see next row). OTA hot-updates the SPA only; native-shell changes still need an APK rebuild + reinstall. |
| First-run seed | `resource_dir/frontend-seed` — real files staged by `bundle.resources` | `include_dir!`-embedded copy of `web/dist`, materialized into `ui/current` before the window opens (`seed::ensure_seed`). Android's APK assets are NOT std::fs-readable, so the desktop resource-dir seed can't be used; embedding sidesteps it and keeps a single stable `cortexui://` origin for the app's whole life. |
| Shell flag | `window.__CORTEX_DESKTOP__ = true` → desktop 3-pane workbench | `window.__CORTEX_MOBILE__ = true` → mobile bottom-Tab shell (`web/src/mobile/`). Set by `SHELL_FLAG` in `init_script()`. |
| Credential store | OS keychain (`keyring` v3) | app-private JSON file in `app_data_dir()` (keyring has no Android backend) — see `creds.rs`. |
| Switch button | injected bottom-right | suppressed (mobile shell owns its own nav) |
| Web router | `HashRouter` (via `isNativeShell()`) | `HashRouter` (same predicate — the `cortexui://` resolver loads `/index.html`) |

`creds.rs` holds the platform-branched credential store (`load`/`save`/`clear`, each taking the
`AppHandle`). `web/src/lib/desktop-config.ts` `isNativeShell()` (= desktop OR mobile) is what both
`router.tsx` and `mobile/mobile-router.tsx` use to pick `HashRouter` — Android sets only
`__CORTEX_MOBILE__`, so keying off `isDesktopShell()` alone would wrongly pick `BrowserRouter`.

⚠️ **CORS origin**: now that Android serves over `cortexui://`, its webview Origin is
`http://cortexui.localhost` (Android/Windows custom-scheme form), NOT the old `http://tauri.localhost`.
The remote server's `CORTEX_UI_CORS_ORIGINS` must list `http://cortexui.localhost` (alongside the
desktop `cortexui://localhost`) or the SPA's cross-origin tRPC calls are blocked. The app talks to
the server over absolute HTTPS URLs (e.g. `https://cortex.fangxm.me`), so no cleartext-traffic policy
is involved.

### Android toolchain (installed under `~/android-tools/`, user-space, no root)

| Component | Version / path |
|---|---|
| JDK | Temurin 17 → `~/android-tools/jdk-17.0.13+11` (AGP needs JDK 17+; system JDK 11 is too old) |
| Android SDK | `~/android-tools/sdk` (`ANDROID_HOME`) — platform-tools, `platforms;android-34`, `build-tools;34.0.0`, `cmake;3.22.1` |
| NDK | `27.1.12297006` → `~/android-tools/sdk/ndk/27.1.12297006` (`NDK_HOME`) |
| Rust targets | `aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |

The generated Android Gradle project lives at `src-tauri/gen/android/` and is **gitignored**
(root `.gitignore` ignores `desktop/src-tauri/gen/`), like the desktop `gen/schemas`. Regenerate
it with `tauri android init` on a fresh checkout — it is derived from `tauri.conf.json`
(applicationId = `identifier` = `dev.cortex.desktop`).

### Build (from `desktop/`)

```bash
export JAVA_HOME=~/android-tools/jdk-17.0.13+11
export ANDROID_HOME=~/android-tools/sdk
export NDK_HOME=~/android-tools/sdk/ndk/27.1.12297006
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

pnpm --filter web build          # build web/dist
npm run copy-connect             # stage connect.html into web/dist
npx tauri android init           # first time only (gen/ is gitignored)
npx tauri android build --debug --apk --target aarch64
# → src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Drop `--target aarch64` to build all ABIs. Debug builds are auto-signed with the debug keystore
and installable for testing, but **keep native-lib debug symbols** (`keepDebugSymbols` in the
generated `build.gradle.kts`), so a universal debug APK is hundreds of MB. For anything you hand
out, build a signed release APK for a single ABI instead (see below). `tauri android dev` runs on
a connected device / emulator.

### On-device logs (logcat)

Android does **not** capture Rust `eprintln!`/stdout in logcat — only native crash tombstones show
up regardless. The shell therefore logs through the `log` facade wired to logcat by `android_logger`
(init in `run()`, tag `cortex-desktop`); the `shell_log!` macro in `lib.rs` is `log::info!` on Android
and `eprintln!` on desktop. Watch the OTA/seed flow with:

```bash
adb logcat -s cortex-desktop            # shell diagnostics only
```

Expected lines across two launches of a device that has a newer server frontend: `ota check
starting: <url>` → `staged frontend update <v> (applies next launch)` on launch A, then
`applied staged frontend update: <v>` on launch B. `ota: already up to date` means the served
version already equals the installed one (nothing to do); `ota check skipped: <err>` means the
manifest/bundle fetch failed (network / token / TLS). The server side logs the matching hit under
the `ui-ota` logger (`manifest served: …` / `bundle served: …`) — a positive signal that a client
reached and authenticated against the OTA endpoint.

### Release build (signed APK)

Release APKs must be signed or Android refuses to install them. A single-ABI release APK is also
~7-10 MB vs the ~450 MB universal debug APK, because release strips + optimizes the Rust `.so` and
one ABI ships instead of four.

**Scripted path (preferred):** `scripts/android-release.sh` does the whole thing — builds the SPA,
stages `connect.html`, runs `tauri android init` only when `gen/android` is missing, writes
`gen/android/app/keystore.properties`, verifies the release signing wiring is present, then builds
+ verifies the signed APK. It reads machine-specific toolchain paths and the keystore
(path/alias/passwords) from a file OUTSIDE the repo — `~/.cortex/config/android-release.env` by
default (override with `CORTEX_ANDROID_ENV`) — so no secrets live in the repo.

```bash
desktop/scripts/android-release.sh                # signed arm64 release APK
desktop/scripts/android-release.sh --init         # force re-init (after a tauri.conf change)
desktop/scripts/android-release.sh --target all   # all ABIs
```

Notes on the wiring it manages:
- `gen/android/` is **gitignored** — `tauri android init` regenerates it and wipes any signing
  setup, so `keystore.properties` is (re)written on every run. The current Tauri CLI template
  already emits the `signingConfigs { create("release") { …keystoreProperties… } }` block + the
  `signingConfig = signingConfigs.getByName("release")` line in `buildTypes.release`; the script
  only asserts they are present (fails loudly if a CLI upgrade drops them) rather than patching.
- `keystore.properties` keys: `storeFile` (absolute) / `storePassword` / `keyAlias` / `keyPassword`.
- Generate a keystore once (outside the repo; never commit):
  `keytool -genkeypair -v -keystore <path>/release.keystore -alias <alias> -keyalg RSA -keysize 2048 -validity 10000 -storepass <pass> -keypass <pass> -dname "CN=Cortex, O=Cortex, C=US"`.
- Output: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`.

Concrete machine paths, the keystore location, and its password are recorded in `~/.cortex`
(machine config + `config/android-release.env`) — not here, since this is a public repo.

## Keychain notes

- Uses `keyring` crate v3 (OS-native: SecretService on Linux, Keychain on macOS, CredMan on Windows).
- ⚠️ **Backend feature flags are load-bearing.** keyring v3 enables NO platform backend by default; with
  `features = []` it silently falls back to an in-process **mock** store — `set_password` succeeds
  in-session but nothing persists, so the connect screen reappears on every launch. Cargo.toml must
  keep `features = ["windows-native", "apple-native", "sync-secret-service", "crypto-rust"]` (each only
  compiles on its matching target). `creds::diagnostics()` now actually round-trips the keychain at
  startup so a broken/mock backend shows up in the log instead of a hard-coded "os-keychain".
- If the secret-service daemon is not running (headless Linux), save fails silently; credentials
  are kept in AppState for the session only (lost on restart). Use env vars as alternative.
- Keychain entry: service=`dev.cortex.desktop`, account=`connection`, value=JSON `ConnectionConfig`.
