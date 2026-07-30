// Cortex Desktop — Tauri v2 shell
//
// Connection flow
// ───────────────
// First run (no stored credentials):
//   Tauri opens connect.html (the connection config screen).
//   User enters serverUrl + clientToken, tests, then clicks Connect.
//   JS calls the `connect` Tauri command → credentials saved to OS keychain
//   and AppState updated. Page navigates to index.html (the SPA workbench).
//
// Subsequent runs (credentials in keychain):
//   Rust loads credentials at startup, opens index.html directly.
//   initialization_script (injected into every page) runs an async Tauri IPC
//   call to get_connection_config() — resolves in microseconds, before the
//   React bundle finishes downloading/parsing. providers.tsx reads
//   window.__CORTEX_DESKTOP_CONFIG and passes it to createTrpcClient().
//
// Disconnect:
//   The SPA's daemon interface (desktop DaemonStatusModal, mobile 1r Daemon
//   screen) offers a Disconnect action that calls the `disconnect` Tauri command
//   (clears keychain + AppState) then navigates to connect.html — the escape hatch
//   back to the connect screen when a saved server is stale/dead.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

/// Emit a diagnostic line from the native shell.
///
/// On Android, Rust `eprintln!`/`println!` (stdout/stderr) is NOT captured by logcat, so the shell's
/// OTA/seed diagnostics were invisible on-device (only native crash tombstones show up). This routes
/// through the `log` facade — wired to logcat by `android_logger` in `run()` — so `adb logcat` sees
/// them under the `cortex-desktop` tag. On desktop it stays `eprintln!` (visible on the terminal).
macro_rules! shell_log {
    ($($arg:tt)*) => {{
        #[cfg(target_os = "android")]
        { log::info!($($arg)*); }
        #[cfg(not(target_os = "android"))]
        { eprintln!($($arg)*); }
    }};
}

mod creds;
// frontend (custom-scheme asset resolver) + ota (self-updating SPA) now run on BOTH desktop and
// Android: the SPA is served over the `cortexui://` scheme from an on-disk frontend directory, and
// the OTA updater (reqwest[rustls]/sha2/zip — all cross-compile cleanly for Android) stages new
// bundles for the next launch. The one platform seam is the first-run seed (see `seed` below):
// desktop reads it from `resource_dir/frontend-seed`, Android from an `include_dir!`-embedded copy.
mod app_update;
mod frontend;
mod ota;
// Android-only: the embedded SPA seed materialized onto disk on first run (desktop uses the real
// files under resource_dir/frontend-seed instead, so this module is not compiled there).
#[cfg(target_os = "android")]
mod seed;

// ─── Frontend source (OTA) ──────────────────────────────────────────────────
/// The custom URI scheme the SPA is served under. A single origin for the SPA's whole life
/// (seed and OTA-downloaded versions alike) so browser-origin state stays stable across updates.
const FRONTEND_SCHEME: &str = "cortexui";

/// Resolve the directory the frontend is currently served from, newest wins:
///   1. `CORTEX_FRONTEND_DIR` env override (dev/testing — point straight at web/dist).
///   2. The OTA-downloaded current version: `<appDataDir>/ui/current` (populated by the updater).
///   3. The bundled seed shipped with the app: `<resourceDir>/frontend-seed` (first-run / offline).
/// A candidate counts only when it contains index.html, so a half-populated dir never wins.
///
/// Both platforms serve over `cortexui://` from disk. On Android the `resource_dir/frontend-seed`
/// fallback is never actually reached because the embedded seed is materialized into `ui/current`
/// before the window opens (see `seed::ensure_seed`); it stays here only as a harmless last resort.
fn active_frontend_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("CORTEX_FRONTEND_DIR") {
        let p = PathBuf::from(dir);
        if p.join("index.html").is_file() {
            return p;
        }
    }
    if let Ok(data) = app.path().app_data_dir() {
        let current = data.join("ui").join("current");
        if current.join("index.html").is_file() {
            return current;
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        return res.join("frontend-seed");
    }
    // Last resort: a path that won't exist → the resolver 404s cleanly instead of panicking.
    PathBuf::from("frontend-seed")
}

// ─── Types ────────────────────────────────────────────────────────────────

/// Connection credentials shared between Rust AppState and the JS global
/// `window.__CORTEX_DESKTOP_CONFIG`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectionConfig {
    /// Absolute URL of the remote Cortex server, e.g. "https://cortex.example.com".
    /// None = no server configured (shows the connect screen).
    #[serde(rename = "serverUrl")]
    pub server_url: Option<String>,
    /// Client authentication token (x-cortex-token value).
    pub token: Option<String>,
}

pub struct AppState {
    pub config: Mutex<ConnectionConfig>,
    /// The downloaded + verified app shell update, when one is ready to install (see app_update.rs).
    pub app_update: Mutex<Option<app_update::AppUpdate>>,
}

// ─── Tauri commands ────────────────────────────────────────────────────────

/// Return the current connection config to the webview.
/// Called by initialization_script on every page load to seed
/// window.__CORTEX_DESKTOP_CONFIG before React mounts.
#[tauri::command]
fn get_connection_config(state: State<AppState>) -> ConnectionConfig {
    state.config.lock().unwrap().clone()
}

/// Low-level in-memory update. Prefer the `connect` command for the full
/// persist-to-keychain flow.
#[tauri::command]
fn set_connection_config(
    state: State<AppState>,
    server_url: Option<String>,
    token: Option<String>,
) {
    let mut config = state.config.lock().unwrap();
    config.server_url = server_url;
    config.token = token;
}

/// Persist credentials to the platform credential store and update AppState.
///
/// Called by the connect screen after the user's test-connection probe
/// succeeds. Always returns Ok — a store failure is logged to stderr but
/// the session continues (credentials are in AppState; lost on restart if the
/// store is unavailable, e.g. headless Linux without a secret-service daemon).
/// Backend is platform-branched (OS keychain on desktop, app-private file on
/// Android) — see `creds.rs`.
#[tauri::command]
fn connect(
    app: tauri::AppHandle,
    state: State<AppState>,
    server_url: String,
    token: String,
) -> Result<(), String> {
    let config = ConnectionConfig {
        server_url: Some(server_url),
        token: Some(token),
    };
    if let Err(e) = creds::save(&app, &config) {
        shell_log!(
            "[cortex-desktop] credential store save failed ({e}); \
             credentials are session-only (lost on restart)"
        );
    }
    *state.config.lock().unwrap() = config;
    Ok(())
}

/// Clear credentials from the platform store and AppState.
///
/// Called by the SPA daemon interface's Disconnect action (web/src/lib/shell-connection.ts).
/// After this returns the SPA navigates to connect.html.
#[tauri::command]
fn disconnect(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    creds::clear(&app);
    *state.config.lock().unwrap() = ConnectionConfig::default();
    Ok(())
}

/// Tauri event raised (to the SPA) when a newer frontend has been downloaded and staged for the next
/// launch — the SPA listens for it to raise the hot-update prompt (design 21a / mobile 3a). Payload is
/// a serialized `ota::StagedUpdate` (`{ version, fromVersion, size }`).
const FRONTEND_UPDATE_STAGED_EVENT: &str = "frontend-update-staged";

/// Apply a staged frontend update by relaunching the app so startup `promote_staged()` swaps the new
/// version in. Called from the hot-update prompt's primary button.
///
/// Desktop relaunches in place (`app.restart()` — never returns). Android has no reliable in-process
/// relaunch, so it exits (design 3a "退出 App"): the process ends and the user / system reopens it,
/// at which point `promote_staged()` applies the update. Either way the running work is untouched —
/// threads execute server-side, not in the app.
#[tauri::command]
fn apply_frontend_update(app: tauri::AppHandle) {
    #[cfg(target_os = "android")]
    {
        app.exit(0);
    }
    #[cfg(not(target_os = "android"))]
    {
        app.restart();
    }
}

/// Return the currently staged frontend update, if any, as a backstop for a missed
/// `frontend-update-staged` event (e.g. the SPA mounted its listener after the event fired). Size is
/// not persisted on disk, so it is reported as 0 here; the live event carries the real size.
#[tauri::command]
fn get_staged_update(app: tauri::AppHandle) -> Option<ota::StagedUpdate> {
    let data = app.path().app_data_dir().ok()?;
    let store = ota::UiStore::new(&data);
    let staged = store.staged_version()?;
    // Only a staged version that actually differs from what is installed is a pending update.
    if store.installed_version().as_deref() == Some(staged.as_str()) {
        return None;
    }
    Some(ota::StagedUpdate {
        version: staged,
        from_version: store.installed_version(),
        size: 0,
    })
}

/// Tauri event raised (to the SPA) when a newer app shell has been downloaded + sha256-verified and
/// is ready to install. Payload is a serialized `app_update::AppUpdate`
/// (`{ version, releaseUrl, notes, size, kind }`). Supersedes the SPA-only hot-update prompt.
const APP_UPDATE_AVAILABLE_EVENT: &str = "app-update-available";

/// Return the prepared app shell update, if any — the SPA's backstop for a missed
/// `app-update-available` event (mirror of `get_staged_update`).
#[tauri::command]
fn get_app_update(state: State<AppState>) -> Option<app_update::AppUpdate> {
    state.app_update.lock().unwrap().clone()
}

/// Install the prepared app shell update. Re-verifies the on-disk file against the manifest sha256
/// first (the download could have been tampered with between staging and install), then hands off
/// per platform (see app_update::install). Returns the opened installer path for the assisted
/// flows (dmg/deb/rpm), None when the shell handed off and is exiting.
#[tauri::command]
fn install_app_update(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let update = state
        .app_update
        .lock()
        .unwrap()
        .clone()
        .ok_or("no app update prepared")?;
    let actual = app_update::hash_file(&update.path).map_err(|e| e.to_string())?;
    if !actual.eq_ignore_ascii_case(&update.sha256) {
        return Err("update file failed verification".to_string());
    }
    app_update::install(&app, &update)
}

/// Skip the offered app version: persist it shell-side (survives SPA OTA swaps) and clear the
/// pending update so this run stops offering it. The next release clears the skip naturally
/// (different version string).
#[tauri::command]
fn skip_app_update(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    let Some(update) = state.app_update.lock().unwrap().take() else {
        return Ok(());
    };
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    app_update::UpdateStore::new(&data)
        .set_skipped(&update.version)
        .map_err(|e| e.to_string())
}

/// Save agent-sent (or user-downloaded) file bytes to disk. A plain browser `<a download>` /
/// `window.open(blob)` is a no-op inside the Tauri WebView, so the SPA fetches the bytes and hands
/// them here (see `web/src/lib/files.downloadFile`). Returns the saved absolute path.
///
/// Destination:
///   - Desktop: the OS download dir (`~/Downloads`), falling back to `app_data_dir/downloads`.
///   - Android: `app_data_dir/downloads` (app-private but retrievable via a file manager under
///     `Android/data/dev.cortex.desktop/`), plus a system notification pointing at the saved file —
///     the public Downloads collection needs MediaStore/DownloadManager (Kotlin/JNI), a documented
///     follow-up.
///
/// `name` is reduced to its basename and stripped of path separators so a crafted name can never
/// escape the destination directory. On a name collision a ` (n)` suffix is appended.
#[tauri::command]
fn save_download(app: tauri::AppHandle, name: String, bytes: Vec<u8>) -> Result<String, String> {
    use std::path::Path;

    // Sanitize: basename only, drop separators / parent refs, fall back to a safe default.
    let base = Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.replace(['/', '\\'], "_"))
        .filter(|s| !s.is_empty() && s != "." && s != "..")
        .unwrap_or_else(|| "download".to_string());

    // Destination directory: OS downloads on desktop, app-private downloads on Android.
    #[cfg(not(target_os = "android"))]
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("downloads")))
        .map_err(|e| format!("no download dir: {e}"))?;
    #[cfg(target_os = "android")]
    let dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("downloads"))
        .map_err(|e| format!("no download dir: {e}"))?;

    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;

    // Avoid clobbering an existing file: `name.ext` → `name (1).ext` → `name (2).ext` …
    let mut target = dir.join(&base);
    if target.exists() {
        let path = Path::new(&base);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(&base);
        let ext = path.extension().and_then(|s| s.to_str());
        for n in 1..1000 {
            let candidate = match ext {
                Some(e) => format!("{stem} ({n}).{e}"),
                None => format!("{stem} ({n})"),
            };
            let p = dir.join(candidate);
            if !p.exists() {
                target = p;
                break;
            }
        }
    }

    std::fs::write(&target, &bytes).map_err(|e| format!("write failed: {e}"))?;
    let saved = target.to_string_lossy().to_string();

    // Android: surface where it landed via a system notification (the app-private dir is not obvious).
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title("已保存")
            .body(format!("{base} → {saved}"))
            .show();
    }

    shell_log!("[cortex-desktop] save_download → {saved}");
    Ok(saved)
}

/// Open a saved file with the OS default application — the desktop download toast's "Open file"
/// action (`web/src/features/media/useDownloadFile.ts`). Desktop-only: the mobile shell surfaces the
/// system Downloads notification instead, so this is never invoked on Android (the Android branch of
/// `open_with_os` just returns an error). `path` is the absolute path returned by `save_download`.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open_with_os(&path)
}

/// Reveal a saved file in the OS file manager — opens its containing folder, selecting the file where
/// the platform supports it (macOS Finder / Windows Explorer). The desktop download toast's "Open
/// folder" action. Desktop-only, same as `open_path`. `path` is the absolute path from `save_download`.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    reveal_with_os(&path)
}

/// Launch an OS opener process fire-and-forget (never wait): file managers like Windows Explorer
/// return non-zero exit codes even on success, so we only care that the process launched, not its
/// exit status. Args are passed directly (no shell), so a path can never be interpreted as a command.
#[allow(dead_code)]
fn spawn_detached(program: &str, args: &[&str]) -> Result<(), String> {
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {program}: {e}"))
}

#[cfg(target_os = "linux")]
fn open_with_os(path: &str) -> Result<(), String> {
    spawn_detached("xdg-open", &[path])
}
#[cfg(target_os = "macos")]
fn open_with_os(path: &str) -> Result<(), String> {
    spawn_detached("open", &[path])
}
#[cfg(target_os = "windows")]
fn open_with_os(path: &str) -> Result<(), String> {
    // `explorer <file>` opens folders, not arbitrary files with their default app — use `start`
    // (via cmd) with an empty title argument so a path is never mistaken for the window title.
    spawn_detached("cmd", &["/C", "start", "", path])
}
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn open_with_os(_path: &str) -> Result<(), String> {
    Err("open_path is desktop-only".to_string())
}

#[cfg(target_os = "linux")]
fn reveal_with_os(path: &str) -> Result<(), String> {
    // Linux file managers have no portable "reveal + select this file", so open the containing folder.
    let parent = std::path::Path::new(path)
        .parent()
        .and_then(|p| p.to_str())
        .ok_or_else(|| "no parent dir".to_string())?;
    spawn_detached("xdg-open", &[parent])
}
#[cfg(target_os = "macos")]
fn reveal_with_os(path: &str) -> Result<(), String> {
    // `-R` reveals the file in Finder with it selected.
    spawn_detached("open", &["-R", path])
}
#[cfg(target_os = "windows")]
fn reveal_with_os(path: &str) -> Result<(), String> {
    // `/select,<path>` opens the containing folder with the file highlighted.
    let arg = format!("/select,{path}");
    spawn_detached("explorer", &[arg.as_str()])
}
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn reveal_with_os(_path: &str) -> Result<(), String> {
    Err("reveal_path is desktop-only".to_string())
}

// ─── Initialization script ─────────────────────────────────────────────────
// Injected into EVERY page load (connect.html and index.html). A per-platform
// PREFIX (see `init_script()`) sets the shell-detection flag first:
//   desktop → window.__CORTEX_DESKTOP__ = true   (desktop three-pane workbench)
//   Android → window.__CORTEX_MOBILE__  = true   (mobile bottom-Tab shell)
// then this shared body runs:
//
// 1. Async-fetches credentials from AppState via IPC and writes to
//    window.__CORTEX_DESKTOP_CONFIG (read by providers.tsx to switch the tRPC
//    client to absolute-URL + token-bearer mode). The IPC round-trip is
//    ~microseconds; the React bundle takes tens of milliseconds to download +
//    parse, so the global is set before providers.tsx reads it. Shared by both
//    platforms — the mobile shell reaches the same remote server the same way.
//
// Disconnect is no longer a shell-injected button — the SPA's daemon interface
// owns a discoverable Disconnect action (web/src/lib/shell-connection.ts) that
// invokes the `disconnect` command + navigates to connect.html.

/// Per-platform flag prefix prepended to `INIT_SCRIPT`.
#[cfg(target_os = "android")]
const SHELL_FLAG: &str = "window.__CORTEX_MOBILE__ = true;\n";
#[cfg(not(target_os = "android"))]
const SHELL_FLAG: &str = "window.__CORTEX_DESKTOP__ = true;\n";

/// The full initialization script: platform flag + **synchronously baked** credentials + shared body.
///
/// The credentials known at window-build time (loaded from the credential store) are serialized
/// straight into the injected script as the initial `window.__CORTEX_DESKTOP_CONFIG` value, so the
/// SPA sees them synchronously — BEFORE any bundle code runs — with no dependency on the async IPC.
/// This closes a race that surfaced on Android: on the second launch the WebView serves a
/// code-cached bundle that mounts React faster than the `get_connection_config` IPC round-trip could
/// resolve, so `providers.tsx` (which reads the config exactly once at mount) captured the stale
/// `{serverUrl:null}` and built a broken tRPC client — the mobile shell rendered (bottom Tab bar)
/// but every data screen failed, leaving "only the bottom bar". Baking removes the race entirely.
///
/// The async IPC in `INIT_SCRIPT` is kept as a REFRESH path: on the first-run connect flow the
/// window was built with empty creds (baked null), then the user saves creds on connect.html and
/// navigates to index.html within the same session — the re-injected script's baked value is still
/// null there, so the async `get_connection_config` fills in the freshly-saved creds.
fn init_script(config: &ConnectionConfig) -> String {
    // Serialize via serde so serverUrl/token are correctly JSON-escaped (quotes, backslashes, etc.),
    // never string-interpolated raw. `ConnectionConfig` serializes to {"serverUrl":…,"token":…},
    // exactly the shape readDesktopConfig() expects. A serialize failure (unreachable for two
    // Option<String>) falls back to the null literal, i.e. the async-IPC-only behaviour.
    let baked = serde_json::to_string(config)
        .unwrap_or_else(|_| r#"{"serverUrl":null,"token":null}"#.to_string());
    format!("{SHELL_FLAG}window.__CORTEX_DESKTOP_CONFIG = {baked};\n{INIT_SCRIPT}")
}

const INIT_SCRIPT: &str = r#"
// Refresh path: re-read the current credentials via IPC and overwrite the baked value. Normally a
// no-op (baked value is already correct); it matters on the first-run connect flow, where the window
// was built before the user saved creds, so the baked value is null and this async call fills it in.
// The baked value already covers the common (subsequent-launch) case synchronously, so this no longer
// races the bundle — a stale read just keeps the correct baked creds.
(function () {
  var tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.core.invoke) return;
  tauri.core.invoke('get_connection_config').then(function (cfg) {
    if (cfg && cfg.serverUrl) {
      window.__CORTEX_DESKTOP_CONFIG = { serverUrl: cfg.serverUrl, token: cfg.token };
    }
  }).catch(function () {});
}());
"#;

/// A credential counts as PRESENT only when it is Some AND non-empty after trimming.
/// `Option::is_some()` is true for `Some("")` / `Some("   ")`, so blank or whitespace-only
/// saved creds (e.g. a half-filled store entry or `CORTEX_SERVER_URL=`) would wrongly route
/// to index.html and leave the user stranded with a dead tRPC client. Requiring a non-empty
/// trimmed value makes garbage creds fall through to connect.html.
fn has_credentials(config: &ConnectionConfig) -> bool {
    let non_blank = |v: &Option<String>| v.as_deref().map(str::trim).is_some_and(|s| !s.is_empty());
    non_blank(&config.server_url) && non_blank(&config.token)
}

/// Load initial credentials: platform credential store first, then env-var fallback
/// (`CORTEX_SERVER_URL` / `CORTEX_TOKEN`, dev convenience). Loaded inside `setup` because the
/// Android store backend needs the `AppHandle` to resolve the app-private data dir.
fn load_initial_config(app: &tauri::AppHandle) -> ConnectionConfig {
    creds::load(app).unwrap_or_else(|| ConnectionConfig {
        server_url: std::env::var("CORTEX_SERVER_URL").ok(),
        token: std::env::var("CORTEX_TOKEN").ok(),
    })
}

// ─── App entry point ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Route the `log` facade to logcat on Android (Rust stderr is not captured there) so the shell's
    // OTA/seed diagnostics are observable via `adb logcat -s cortex-desktop`. init_once is safe to call
    // unconditionally on every launch. No-op on desktop (uses eprintln! via shell_log!).
    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("cortex-desktop"),
    );

    // Install ring as the process-wide rustls crypto provider before any OTA request builds a TLS
    // client (reqwest is compiled with `rustls-no-provider`, so it relies on this default). Idempotent
    // — a second call would Err, which we ignore. Must run before the background OTA thread starts.
    let _ = rustls::crypto::ring::default_provider().install_default();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // Native OS/system notifications for the SPA (design 1q). The JS side
        // (@tauri-apps/plugin-notification via web/src/features/notifications/os-notify.ts) invokes
        // this plugin's commands; it is the only path to a real OS notification inside the Android
        // WebView, which has no web Notifications API.
        .plugin(tauri_plugin_notification::init())
        // Android public-Downloads bridge (DownloadManager). Desktop registers a stub; the desktop
        // download path stays the `save_download` command below.
        .plugin(tauri_plugin_cortex_download::init())
        .manage(AppState {
            config: Mutex::new(ConnectionConfig::default()),
            app_update: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_connection_config,
            set_connection_config,
            connect,
            disconnect,
            apply_frontend_update,
            get_staged_update,
            get_app_update,
            install_app_update,
            skip_app_update,
            save_download,
            open_path,
            reveal_path,
        ]);

    // Both platforms: serve the SPA over the custom `cortexui://` scheme from the active frontend
    // directory (env override → OTA-downloaded current → bundled seed), so the frontend can be
    // swapped by the updater. resolve_asset applies the SPA fallback + traversal guard + MIME. On
    // Android `ui/current` is seeded from the embedded copy before the window opens (see setup).
    builder = builder.register_uri_scheme_protocol(FRONTEND_SCHEME, |ctx, request| {
        let uri = request.uri().to_string();
        // connect.html is a shell-local page not shipped in the server OTA bundle. Serve it from the
        // binary-embedded copy first so the connection screen is always reachable, even when the
        // active frontend dir is an OTA bundle that lacks it (otherwise it SPA-falls-back to the
        // workbench with no server config → blank "can't connect"). All other paths fall through to
        // the normal on-disk resolver.
        let asset = frontend::resolve_embedded(&uri)
            .unwrap_or_else(|| frontend::resolve_asset(&active_frontend_dir(ctx.app_handle()), &uri));
        tauri::http::Response::builder()
            .status(asset.status)
            .header(tauri::http::header::CONTENT_TYPE, asset.mime)
            .body(asset.body)
            .expect("build custom-scheme response")
    });

    builder
        .setup(move |app| {
            // Load credentials (platform store → env fallback) and seed AppState.
            shell_log!("[cortex-desktop] {}", creds::diagnostics(&app.handle()));
            let initial_config = load_initial_config(&app.handle());
            let open_workbench = has_credentials(&initial_config);
            shell_log!("[cortex-desktop] initial credentials present={open_workbench}");
            // Keep a copy to bake synchronously into the window's initialization_script (below), so
            // the SPA sees the credentials before any bundle code runs (no async-IPC race).
            let baked_config = initial_config.clone();
            *app.state::<AppState>().config.lock().unwrap() = initial_config;

            // Open the workbench directly when credentials are available; otherwise the connect screen.
            let initial_file = if open_workbench { "index.html" } else { "connect.html" };

            // ── Pre-window: apply any staged update, then guarantee a servable frontend on disk ──
            // Promote first so this launch serves a bundle downloaded in a previous session, and the
            // running SPA is never swapped underneath itself. On Android, if `ui/current` is still
            // empty afterwards (first run / offline), materialize the embedded seed into it so the
            // cortexui:// resolver has something to serve (desktop falls back to resource_dir instead).
            if let Ok(data) = app.path().app_data_dir() {
                let store = ota::UiStore::new(&data);
                match store.promote_staged() {
                    Ok(Some(v)) => shell_log!("[cortex-desktop] applied staged frontend update: {v}"),
                    Ok(None) => shell_log!("[cortex-desktop] no staged frontend to promote"),
                    Err(e) => shell_log!("[cortex-desktop] promote staged frontend failed: {e}"),
                }
                #[cfg(target_os = "android")]
                {
                    match seed::ensure_seed(&store.current_dir()) {
                        Ok(true) => shell_log!("[cortex-desktop] extracted embedded frontend seed"),
                        Ok(false) => {}
                        Err(e) => shell_log!("[cortex-desktop] seed extract failed: {e}"),
                    }
                }
                shell_log!(
                    "[cortex-desktop] frontend dir: installed_version={:?}",
                    store.installed_version()
                );
            }

            // ── Open the window against the cortexui:// scheme (both platforms) ──
            let url = format!("{FRONTEND_SCHEME}://localhost/{initial_file}");
            #[allow(unused_mut)]
            let mut win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::CustomProtocol(url.parse().expect("valid cortexui:// url")),
            )
            .initialization_script(&init_script(&baked_config));
            // Desktop-only window chrome (Android manages its own full-screen activity).
            // `disable_drag_drop_handler()` turns OFF Tauri's native OS-level file drag-drop
            // interception so the webview's own HTML5 DnD events reach the DOM — without it the
            // OS handler swallows file drops and the Composer's `onDrop` never fires (the "拖入
            // 文件没反应" bug; the browser has no such interception, so it works there).
            #[cfg(not(target_os = "android"))]
            {
                win = win
                    .title("Cortex")
                    .inner_size(1400.0, 900.0)
                    .resizable(true)
                    .disable_drag_drop_handler();
            }
            win.build()?;

            // ── Background OTA check (both platforms) ──
            // Fetch the manifest, download + verify a newer bundle, and stage it for the next launch.
            // Non-blocking and offline-safe — any failure is a logged no-op and the current version
            // keeps serving.
            if let Ok(data) = app.path().app_data_dir() {
                let cfg = app.state::<AppState>().config.lock().unwrap().clone();
                if let (Some(url), Some(token)) = (cfg.server_url, cfg.token) {
                    // Clone the handle so the background thread can emit the staged-update event to the
                    // SPA (raises the hot-update prompt, design 21a / mobile 3a).
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        shell_log!("[cortex-desktop] ota check starting: {url}");
                        let store = ota::UiStore::new(&data);
                        match ota::check_and_stage(&url, &token, &store) {
                            Ok(Some(update)) => {
                                shell_log!(
                                    "[cortex-desktop] staged frontend update {} (applies next launch)",
                                    update.version
                                );
                                // Tell the SPA a new version is ready so it can prompt the user to
                                // restart. Non-fatal if no window is listening yet — the
                                // `get_staged_update` command is the backstop.
                                if let Err(e) = handle.emit(FRONTEND_UPDATE_STAGED_EVENT, &update) {
                                    shell_log!(
                                        "[cortex-desktop] emit {FRONTEND_UPDATE_STAGED_EVENT} failed: {e}"
                                    );
                                }
                            }
                            Ok(None) => shell_log!("[cortex-desktop] ota: already up to date"),
                            Err(e) => shell_log!("[cortex-desktop] ota check skipped: {e}"),
                        }
                    });
                } else {
                    shell_log!("[cortex-desktop] ota check not started: no credentials");
                }
            }

            // ── Background app-shell update check (both platforms) ──
            // Asks the connected server's /api/app-update/manifest.json for a newer shell (capped
            // at the server's own version), downloads + verifies it, then emits
            // `app-update-available` so the SPA raises the ONE update prompt. Re-checks daily for
            // long-running instances. Dev builds (non-CalVer version, e.g. 0.0.1) never check.
            {
                let own_version = app.package_info().version.to_string();
                let cfg = app.state::<AppState>().config.lock().unwrap().clone();
                let data = app.path().app_data_dir().ok();
                if std::env::var("CORTEX_APP_UPDATE_DISABLE").as_deref() == Ok("1") {
                    shell_log!("[cortex-desktop] app-update check disabled by env");
                } else if !app_update::is_calver(&own_version) {
                    shell_log!("[cortex-desktop] app-update check skipped: dev version {own_version}");
                } else if let (Some(data), Some(url), Some(token)) =
                    (data, cfg.server_url, cfg.token)
                {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || loop {
                        let store = app_update::UpdateStore::new(&data);
                        let kind = app_update::wanted_kind();
                        match app_update::check_and_prepare(
                            &url,
                            &token,
                            &own_version,
                            app_update::OS_NAME,
                            app_update::ARCH_NAME,
                            &kind,
                            &store,
                        ) {
                            Ok(Some(update)) => {
                                shell_log!(
                                    "[cortex-desktop] app update {} ready ({} {})",
                                    update.version,
                                    update.kind,
                                    update.size
                                );
                                *handle.state::<AppState>().app_update.lock().unwrap() =
                                    Some(update.clone());
                                if let Err(e) = handle.emit(APP_UPDATE_AVAILABLE_EVENT, &update) {
                                    shell_log!(
                                        "[cortex-desktop] emit {APP_UPDATE_AVAILABLE_EVENT} failed: {e}"
                                    );
                                }
                            }
                            Ok(None) => shell_log!("[cortex-desktop] app update: none applicable"),
                            Err(e) => shell_log!("[cortex-desktop] app update check skipped: {e}"),
                        }
                        std::thread::sleep(std::time::Duration::from_secs(24 * 60 * 60));
                    });
                } else {
                    shell_log!("[cortex-desktop] app-update check not started: no credentials");
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
