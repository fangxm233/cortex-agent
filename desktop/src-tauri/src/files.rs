use std::path::Path;
use tauri::Manager;

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
///
/// Errors are `code: detail`, worded by web/src/features/media/useDownloadFile.ts.
#[tauri::command]
pub fn save_download(app: tauri::AppHandle, name: String, bytes: Vec<u8>) -> Result<String, String> {
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
        .map_err(|e| format!("download_dir_unavailable: {e}"))?;
    #[cfg(target_os = "android")]
    let dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("downloads"))
        .map_err(|e| format!("download_dir_unavailable: {e}"))?;

    std::fs::create_dir_all(&dir).map_err(|e| format!("download_dir_create_failed: {e}"))?;

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

    std::fs::write(&target, &bytes).map_err(|e| format!("download_write_failed: {e}"))?;
    let saved = target.to_string_lossy().to_string();

    // Android: surface where it landed via a system notification (the app-private dir is not obvious).
    // Only pre-DownloadManager pages still reach this and nothing tells Rust the UI language, so the
    // notification carries no prose: the file name as title, the saved path as body.
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title(&base)
            .body(&saved)
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
pub fn open_path(path: String) -> Result<(), String> {
    open_with_os(&path)
}

/// Reveal a saved file in the OS file manager — opens its containing folder, selecting the file where
/// the platform supports it (macOS Finder / Windows Explorer). The desktop download toast's "Open
/// folder" action. Desktop-only, same as `open_path`. `path` is the absolute path from `save_download`.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    reveal_with_os(&path)
}

/// Launch an OS opener process fire-and-forget (never wait): file managers like Windows Explorer
/// return non-zero exit codes even on success, so we only care that the process launched, not its
/// exit status. Args are passed directly (no shell), so a path can never be interpreted as a command.
#[cfg_attr(
    not(any(target_os = "linux", target_os = "macos", target_os = "windows")),
    allow(dead_code)
)]
fn spawn_detached(program: &str, args: &[&str]) -> Result<(), String> {
    crate::no_console_window(&mut std::process::Command::new(program))
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
