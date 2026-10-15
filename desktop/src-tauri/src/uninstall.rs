//! The uninstaller is this app started as `cortex-desktop --uninstall`: a small window that asks
//! what to remove and removes it. Every entry point launches it — the settings action, and on
//! Windows the NSIS uninstaller (`--from-installer`), which reads the exit code below and then
//! deletes the program files itself.
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

use crate::install_site;
use crate::setup::teardown;

mod removal;

pub const UNINSTALL_ARG: &str = "--uninstall";
pub const FROM_INSTALLER_ARG: &str = "--from-installer";
/// Exit codes `windows/hooks.nsh` acts on. Anything else falls back to the stock confirm page.
pub const EXIT_PROCEED: i32 = 0;
pub const EXIT_PROCEED_DELETE_DATA: i32 = 10;
pub const EXIT_CANCELLED: i32 = 20;
/// The uninstaller is the only window in its process. It takes the workbench's label because the
/// window capability and the SPA's caption buttons are both bound to `main`.
pub const WINDOW_LABEL: &str = "main";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Launch {
    pub from_installer: bool,
}

/// Some(..) when this process was started as the uninstaller.
pub fn launch() -> Option<Launch> {
    static LAUNCH: OnceLock<Option<Launch>> = OnceLock::new();
    *LAUNCH.get_or_init(|| parse_launch(std::env::args().skip(1)))
}

pub fn parse_launch(args: impl IntoIterator<Item = String>) -> Option<Launch> {
    let args: Vec<String> = args.into_iter().collect();
    args.iter().any(|a| a == UNINSTALL_ARG).then(|| Launch {
        from_installer: args.iter().any(|a| a == FROM_INSTALLER_ARG),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Done,
    Skipped,
    Failed,
    /// The user has to finish it (e.g. delete a portable copy's folder).
    Manual,
    /// The NSIS uninstaller finishes it after this window closes.
    Deferred,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Step {
    pub step: &'static str,
    pub status: StepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Step {
    pub fn new(step: &'static str, status: StepStatus) -> Self {
        Step { step, status, detail: None }
    }

    /// Command output can be long; the tail is where the reason is.
    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        let detail: String = detail.into();
        let trimmed = detail.trim();
        let start = trimmed.char_indices().rev().nth(599).map_or(0, |(i, _)| i);
        self.detail = Some(trimmed[start..].to_string());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    App,
    Server,
}

/// What `uninstall_run` did, read when the window closes.
#[derive(Debug, Clone, Copy, Default)]
pub struct Outcome {
    pub ran: bool,
    pub delete_data: bool,
}

static OUTCOME: Mutex<Outcome> = Mutex::new(Outcome { ran: false, delete_data: false });

/// Closing without having uninstalled cancels; the installer only proceeds after a completed run.
pub fn exit_code(launch: Launch, outcome: Outcome, proceed: bool) -> i32 {
    match (launch.from_installer, proceed && outcome.ran, outcome.delete_data) {
        (false, _, _) => EXIT_PROCEED,
        (true, false, _) => EXIT_CANCELLED,
        (true, true, true) => EXIT_PROCEED_DELETE_DATA,
        (true, true, false) => EXIT_PROCEED,
    }
}

// ─── Tauri commands ────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallInfo {
    /// A server this app installed lives on this machine.
    local_server: bool,
    /// Its Cortex home — what "delete data" removes along with the server.
    home: Option<String>,
    /// This app's own data directories.
    app_data: Vec<String>,
    /// How the app itself is removed: installer | trash | file | package | manual.
    removal: &'static str,
    app_location: Option<String>,
    from_installer: bool,
}

#[tauri::command]
pub async fn uninstall_info(app: AppHandle) -> Result<UninstallInfo, String> {
    tauri::async_runtime::spawn_blocking(move || info(&app))
        .await
        .map_err(|e| format!("UNINSTALL_TASK_FAILED: {e}"))
}

fn info(app: &AppHandle) -> UninstallInfo {
    let launch = launch().unwrap_or_default();
    let server = teardown::local_server();
    let removal = removal::Removal::for_site(&install_site::detect(), launch.from_installer);
    UninstallInfo {
        local_server: server.is_some(),
        home: server.map(|s| s.home.display().to_string()),
        app_data: removal::app_data_dirs(app).iter().map(|d| d.display().to_string()).collect(),
        removal: removal.kind(),
        app_location: removal.location().map(|p| p.display().to_string()),
        from_installer: launch.from_installer,
    }
}

#[tauri::command]
pub async fn uninstall_run(app: AppHandle, scope: Scope, delete_data: bool) -> Result<Vec<Step>, String> {
    tauri::async_runtime::spawn_blocking(move || run(&app, scope, delete_data))
        .await
        .map_err(|e| format!("UNINSTALL_TASK_FAILED: {e}"))
}

/// The app is only removed once the server part succeeded, so a failure can be retried from here.
fn run(app: &AppHandle, scope: Scope, delete_data: bool) -> Vec<Step> {
    let mut steps = match (scope, teardown::local_server()) {
        (Scope::Server, Some(server)) => teardown::teardown(&server, delete_data),
        _ => Vec::new(),
    };
    if steps.iter().any(|s| s.status == StepStatus::Failed) {
        return steps;
    }
    if delete_data {
        crate::creds::clear(app);
        steps.push(Step::new("credentials", StepStatus::Done));
    }
    let launch = launch().unwrap_or_default();
    let removal = removal::Removal::for_site(&install_site::detect(), launch.from_installer);
    steps.push(removal::remove_app(&removal));
    *OUTCOME.lock().unwrap() = Outcome { ran: true, delete_data };
    steps
}

/// Leave the uninstaller. `proceed` = the user finished rather than cancelled.
#[tauri::command]
pub fn uninstall_exit(app: AppHandle, proceed: bool) {
    finish(&app, proceed);
}

fn finish(app: &AppHandle, proceed: bool) {
    let launch = launch().unwrap_or_default();
    let outcome = *OUTCOME.lock().unwrap();
    // Under the NSIS uninstaller these directories are still open in this process; it deletes them.
    if outcome.ran && outcome.delete_data && !launch.from_installer {
        for dir in removal::app_data_dirs(app) {
            let _ = remove_tree(&dir);
        }
    }
    app.exit(exit_code(launch, outcome, proceed));
}

/// The settings action: hand over to the uninstaller and quit, so nothing of this window survives.
#[tauri::command]
pub fn uninstall_open(app: AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("UNINSTALL_START_FAILED: {e}"))?;
    let (program, args) = removal::launcher(&install_site::detect(), &exe);
    let mut command = std::process::Command::new(&program);
    crate::no_console_window(&mut command)
        .args(args)
        .spawn()
        .map_err(|e| format!("UNINSTALL_START_FAILED: {}: {e}", program.display()))?;
    // Latch the update gate: quitting must not install a pending update on the way out.
    if let Ok(mut operation) = crate::update_checks::OPERATIONS.begin() {
        *operation = true;
    }
    app.exit(0);
    Ok(())
}

// ─── Window ────────────────────────────────────────────────────────────────

/// The uninstaller's only window. It skips everything a normal launch does (credentials, daemon,
/// updates) and is served the SPA this binary was built with.
pub fn open_window(app: &tauri::App, title_bar: &str) -> tauri::Result<()> {
    let url = crate::webview_scripts::launch_url("uninstall.html");
    let config = crate::connection::PageConfig::from(&crate::ConnectionConfig::default());
    let win = tauri::WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        tauri::WebviewUrl::CustomProtocol(url.parse().expect("valid cortexui:// url")),
    )
    .initialization_script_for_all_frames(crate::webview_scripts::TITLE_BRIDGE_SCRIPT)
    .initialization_script(&crate::webview_scripts::init_script(&config, title_bar))
    .title("Cortex")
    .inner_size(760.0, 720.0)
    .min_inner_size(560.0, 560.0)
    .resizable(true);
    crate::desktop_chrome(win).build()?;
    Ok(())
}

/// The window's close button means "done" after a run and "cancel" before one.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if launch().is_none() || window.label() != WINDOW_LABEL {
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        finish(window.app_handle(), true);
    }
}

// ─── Files ─────────────────────────────────────────────────────────────────

/// Delete a directory tree. Ok(false) = it was not there. On Windows a just-stopped process can
/// hold files for a moment and read-only files refuse deletion, so both get a few more tries.
pub fn remove_tree(path: &Path) -> Result<bool, String> {
    if std::fs::symlink_metadata(path).is_err() {
        return Ok(false);
    }
    let mut last = String::new();
    for attempt in 0..5u64 {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(e) => last = e.to_string(),
        }
        if !cfg!(windows) {
            break;
        }
        clear_readonly(path);
        std::thread::sleep(std::time::Duration::from_millis(300 * (attempt + 1)));
    }
    Err(format!("cannot remove {}: {last}", path.display()))
}

#[cfg(windows)]
fn clear_readonly(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if meta.is_dir() {
            clear_readonly(&path);
        } else if meta.permissions().readonly() {
            let mut permissions = meta.permissions();
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(&path, permissions);
        }
    }
}

#[cfg(not(windows))]
fn clear_readonly(_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_the_uninstall_flag_starts_the_uninstaller() {
        assert_eq!(parse_launch(args(&[])), None);
        assert_eq!(parse_launch(args(&["--from-installer"])), None);
        assert_eq!(parse_launch(args(&["--uninstall"])), Some(Launch { from_installer: false }));
        assert_eq!(
            parse_launch(args(&["--uninstall", "--from-installer"])),
            Some(Launch { from_installer: true })
        );
    }

    #[test]
    fn the_installer_proceeds_only_after_a_completed_run() {
        let installer = Launch { from_installer: true };
        let none = Outcome::default();
        let kept = Outcome { ran: true, delete_data: false };
        let purged = Outcome { ran: true, delete_data: true };
        assert_eq!(exit_code(installer, none, true), EXIT_CANCELLED);
        assert_eq!(exit_code(installer, kept, false), EXIT_CANCELLED);
        assert_eq!(exit_code(installer, kept, true), EXIT_PROCEED);
        assert_eq!(exit_code(installer, purged, true), EXIT_PROCEED_DELETE_DATA);
        // Started from the app there is no installer waiting on the result.
        assert_eq!(exit_code(Launch::default(), none, false), EXIT_PROCEED);
        assert_eq!(exit_code(Launch::default(), purged, true), EXIT_PROCEED);
    }

    #[test]
    fn step_detail_keeps_the_tail_of_long_output() {
        let long = format!("{}END", "x".repeat(2000));
        let step = Step::new("daemon", StepStatus::Failed).detail(long);
        let detail = step.detail.unwrap();
        assert_eq!(detail.chars().count(), 600);
        assert!(detail.ends_with("END"));
        assert_eq!(Step::new("a", StepStatus::Done).detail("  short \n").detail.as_deref(), Some("short"));
    }

    #[test]
    fn removing_a_missing_tree_is_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(remove_tree(&root.path().join("absent")), Ok(false));
        let tree = root.path().join("tree/nested");
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::write(tree.join("file"), b"x").unwrap();
        assert_eq!(remove_tree(&root.path().join("tree")), Ok(true));
        assert!(!root.path().join("tree").exists());
    }
}
