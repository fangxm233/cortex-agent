use std::sync::Mutex;
use tauri::Manager;

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

// Port forward (plan/embedded-browser.md §4): a real local listener relaying TCP over the server's
// authenticated `/forward` WebSocket. Desktop only — the Android shell gets a refusing stub so the
// command list and managed state stay identical on every platform.
#[cfg(not(target_os = "android"))]
mod forward;
#[cfg(target_os = "android")]
#[path = "forward_stub.rs"]
mod forward;

#[cfg(target_os = "macos")]
mod traffic_lights;

// macOS system menu bar, built from the model the SPA sends. Compiled everywhere: the command must
// exist on every platform so the JS side has one call path, and it answers `false` off macOS.
mod native_menu;

// Windows: re-owns copies made inside the webview so Clipboard History (Win+V) lists them.
#[cfg(target_os = "windows")]
mod clipboard_history;
mod connection;
mod creds;
mod files;
mod mobile_notifications;
mod desktop_notifications;
// frontend (custom-scheme asset resolver) + ota (self-updating SPA) now run on BOTH desktop and
// Android: the SPA is served over the `cortexui://` scheme from an on-disk frontend directory, and
// the OTA updater (reqwest[rustls]/sha2/zip — all cross-compile cleanly for Android) stages new
// bundles for the next launch. The one platform seam is the first-run seed (see `seed` below):
// desktop reads it from `resource_dir/frontend-seed`, Android from an `include_dir!`-embedded copy.
mod app_update;
// Where this build actually lives on disk (and therefore what may be done to it). Consulted by
// app_update for asset selection and by update_checks for the silent-apply decision.
mod install_site;
mod setup;
// Anonymous telemetry: the install id and the panic hook (the setup funnel is in `setup`).
mod telemetry;
// `cortex-desktop --uninstall`: the uninstaller window every uninstall entry point launches.
// Android uninstalls through the system; its shell gets refusing stubs so the command list stays
// identical on every platform.
#[cfg(not(target_os = "android"))]
mod uninstall;
#[cfg(target_os = "android")]
#[path = "uninstall_stub.rs"]
mod uninstall;
mod frontend;
mod ota;
mod update_checks;
// Shell-side update preferences (silent opt-out + failure counter), stored next to the installers.
mod update_prefs;
mod webview_scripts;
#[cfg(test)]
mod update_checks_tests;
// Android-only: the embedded SPA seed materialized onto disk on first run (desktop uses the real
// files under resource_dir/frontend-seed instead, so this module is not compiled there).
#[cfg(any(target_os = "android", test))]
mod seed;

pub use connection::{ConnectionConfig, ConnectionMode};

pub struct AppState {
    pub config: Mutex<ConnectionConfig>,
    /// The downloaded + verified app shell update, when one is ready to install (see app_update.rs).
    pub app_update: Mutex<Option<app_update::AppUpdate>>,
}

/// A GUI process that starts a console program (`reg`, `cmd`) gets a console window flashed on
/// screen for it on Windows unless the child is created without one. A no-op elsewhere.
pub(crate) fn no_console_window(command: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The title bar the SPA draws on desktop: under the macOS traffic lights, or all of it elsewhere.
#[cfg(not(target_os = "android"))]
fn desktop_title_bar_mode() -> &'static str {
    if cfg!(target_os = "macos") {
        "overlay"
    } else {
        "custom"
    }
}

/// Window chrome matching `desktop_title_bar_mode`, shared by the workbench and the uninstaller.
#[cfg(not(target_os = "android"))]
pub(crate) fn desktop_chrome<'a, R: tauri::Runtime, M: Manager<R>>(
    win: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    // macOS keeps its decorations: Overlay is the supported way to run content under the title
    // bar, and it preserves the native traffic lights, fullscreen button and window menu. The
    // lights are centred in the SPA's 44px bar.
    #[cfg(target_os = "macos")]
    {
        let lights = traffic_lights::position();
        shell_log!("[cortex-desktop] traffic lights at ({}, {})", lights.x, lights.y);
        win.title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(lights)
            .hidden_title(true)
    }
    // Windows / Linux draw nothing: the SPA paints the caption buttons. `shadow` keeps the drop
    // shadow (and, on Windows 11, the rounded corners) that an undecorated window otherwise loses;
    // tao still handles the resize borders and Aero Snap for undecorated windows.
    #[cfg(not(target_os = "macos"))]
    {
        win.decorations(false).shadow(true)
    }
}

fn initial_url(config: &ConnectionConfig, runtime_repair: bool) -> String {
    let (document, fragment) = connection::initial_route(config, runtime_repair);
    let mut url = webview_scripts::launch_url(document);
    // launch_url adds the launch query; a hash route must follow it, never precede it.
    url.push_str(fragment);
    url
}

#[cfg(test)]
mod initial_route_tests {
    use super::*;

    #[test]
    fn pending_launch_keeps_query_before_provider_fragment() {
        let config = ConnectionConfig {
            server_url: Some("http://127.0.0.1:3004".into()),
            token: Some("test-token".into()),
            mode: ConnectionMode::Local,
            provider_setup_pending: true,
            ..ConnectionConfig::default()
        };
        assert_eq!(
            initial_url(&config, false),
            "cortexui://localhost/index.html?launch#/setup/providers"
        );
    }

    #[test]
    fn repair_launch_keeps_query_before_local_fragment() {
        assert_eq!(
            initial_url(&ConnectionConfig::default(), true),
            "cortexui://localhost/connect.html?launch#/local"
        );
    }
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
        // Keep desktop delivery and Android permission prompts compatible with older frontends.
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_cortex_notifications::init())
        // Open external authorization URLs in the system browser on every native platform.
        .plugin(tauri_plugin_opener::init())
        // Android public-Downloads bridge (DownloadManager). Desktop registers a stub; the desktop
        // download path stays the `save_download` command below.
        .plugin(tauri_plugin_cortex_download::init())
        .manage(AppState {
            config: Mutex::new(ConnectionConfig::default()),
            app_update: Mutex::new(None),
        })
        .manage(forward::ForwardState::default())
        .manage(desktop_notifications::NotificationState::default())
        .invoke_handler(tauri::generate_handler![
            connection::get_connection_config,
            connection::connect,
            connection::finish_provider_setup,
            connection::disconnect,
            mobile_notifications::mobile_notifications_configure,
            mobile_notifications::mobile_notifications_status,
            desktop_notifications::desktop_notifications_post,
            desktop_notifications::desktop_notifications_pending,
            desktop_notifications::desktop_notifications_ack,
            update_checks::check_for_updates,
            update_checks::apply_frontend_update,
            update_checks::get_staged_update,
            update_checks::get_app_update,
            update_checks::install_app_update,
            update_checks::skip_app_update,
            update_checks::get_update_prefs,
            update_checks::set_update_silent,
            files::save_download,
            files::open_path,
            files::reveal_path,
            setup::setup_probe,
            setup::claude::setup_claude_status,
            setup::claude::setup_install_claude,
            setup::setup_install_server,
            setup::setup_cancel_install,
            setup::setup_run_init,
            setup::setup_enable_ui,
            setup::setup_start_daemon,
            setup::setup_enable_autostart,
            setup::setup_terminal_cli,
            setup::telemetry::setup_telemetry_lang,
            telemetry::telemetry_take_native_crash,
            forward::forward_start,
            forward::forward_stop,
            forward::forward_list,
            native_menu::set_native_menu,
            uninstall::uninstall_info,
            uninstall::uninstall_run,
            uninstall::uninstall_exit,
            uninstall::uninstall_open,
        ]);

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.on_window_event(uninstall::on_window_event);
    }

    // A native menu click carries only its id; the SPA looks that id up in the same model it sent
    // and runs the same handler the in-window bar would have. Failing to emit is a no-op (no window
    // yet), never fatal. Desktop only: `Builder::on_menu_event` is `cfg(desktop)` in Tauri v2 — menus
    // do not exist on the mobile shell, so hooking it there does not compile.
    #[cfg(not(target_os = "android"))]
    {
        use tauri::Emitter;
        builder = builder.on_menu_event(|app, event| {
            let id = event.id().0.clone();
            if let Err(e) = app.emit(native_menu::MENU_EVENT, id) {
                shell_log!("[cortex-desktop] emit {} failed: {e}", native_menu::MENU_EVENT);
            }
        });
    }

    // Both platforms serve the SPA over the custom `cortexui://` scheme. Once connected, from the
    // active frontend directory (env override → OTA-downloaded current → bundled seed), so the
    // updater can swap it; until then, from the seed this shell was built with, whose connect and
    // setup screens match its commands (frontend::resolve_seed). The resolvers apply the SPA
    // fallback + traversal guard + MIME.
    builder = builder.register_uri_scheme_protocol(frontend::SCHEME, |ctx, request| {
        let uri = request.uri().to_string();
        let app = ctx.app_handle();
        let connected = connection::has_credentials(&app.state::<AppState>().config.lock().unwrap());
        let asset = if connected {
            frontend::resolve_asset(&frontend::active_dir(app), &uri)
        } else {
            frontend::resolve_seed(app, &uri)
        };
        tauri::http::Response::builder()
            .status(asset.status)
            .header(tauri::http::header::CONTENT_TYPE, asset.mime)
            .body(asset.body)
            .expect("build custom-scheme response")
    });

    builder
        .setup(move |app| {
            // First, so a panic anywhere after this is on disk for the next launch to report.
            if let Some(dir) = telemetry::telemetry_dir(app.handle()) {
                telemetry::install_panic_hook(dir, app.package_info().version.to_string());
            }
            #[cfg(not(target_os = "android"))]
            if uninstall::launch().is_some() {
                uninstall::open_window(app, desktop_title_bar_mode())?;
                return Ok(());
            }
            // Load credentials (platform store → env fallback) and seed AppState.
            shell_log!("[cortex-desktop] {}", creds::diagnostics(&app.handle()));
            let initial_config = connection::load_initial_config(&app.handle());

            // A local install has no one else to start it: bring the daemon up before the workbench
            // opens onto a dead server. Bounded — see setup::ensure_local_daemon.
            let mut runtime_repair = false;
            if initial_config.mode == ConnectionMode::Local {
                match (
                    initial_config.cortex_bin.as_deref(),
                    initial_config.server_url.as_deref(),
                    initial_config.token.as_deref(),
                ) {
                    (Some(bin), Some(url), Some(token)) => {
                        let ready = setup::ensure_local_daemon(app.handle(), bin, url, token);
                        runtime_repair = !ready && setup::local_runtime_needs_repair();
                        shell_log!("[cortex-desktop] local daemon ready={ready}");
                    }
                    _ => shell_log!("[cortex-desktop] local mode without a usable install record"),
                }
            }

            let open_workbench = connection::has_credentials(&initial_config) && !runtime_repair;
            shell_log!("[cortex-desktop] initial credentials present={open_workbench}");
            // Bake the page's view of these credentials into the window's initialization_script
            // (below), so the launch document sees them before any bundle code runs.
            let baked_config = connection::PageConfig::from(&initial_config);
            let url = initial_url(&initial_config, runtime_repair);
            *app.state::<AppState>().config.lock().unwrap() = initial_config;

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

            // Desktop always uses app-drawn chrome, independent of the OTA content hash.
            // Hand the same mode to the SPA so its window controls match the native window.
            #[cfg(not(target_os = "android"))]
            let title_bar_mode = desktop_title_bar_mode();
            #[cfg(target_os = "android")]
            let title_bar_mode = "native";
            shell_log!("[cortex-desktop] title bar mode: {title_bar_mode}");

            // ── Open the window against the cortexui:// scheme (both platforms) ──
            #[allow(unused_mut)]
            let mut win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::CustomProtocol(url.parse().expect("valid cortexui:// url")),
            )
            .initialization_script_for_all_frames(webview_scripts::TITLE_BRIDGE_SCRIPT)
            .initialization_script(&webview_scripts::init_script(&baked_config, title_bar_mode));
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
                win = desktop_chrome(win);
            }
            win.build()?;

            #[cfg(target_os = "windows")]
            clipboard_history::start();
            update_checks::start_background(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // `Exit` rather than `ExitRequested`: it is the one event every shutdown path reaches,
        // including `app.exit(0)` from the update commands themselves (harmless — the operation
        // gate is already latched then, so the hook returns immediately).
        .run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                update_checks::apply_pending_on_exit(handle);
            }
        });
}
