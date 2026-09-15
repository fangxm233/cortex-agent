// input:  OTA and shell update stores, AppState, Tauri events
// output: Serialized check outcomes and exclusive update operations
// pos:    Shared manual and background update coordinator
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

use crate::install_site::{self, Apply};
use crate::update_prefs::{PrefsStore, UpdatePrefs};
use crate::{app_update, ota, AppState};
use serde::Serialize;
use std::sync::{Mutex, MutexGuard, TryLockError};
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Available,
    Current,
    Skipped,
    Error,
}

/// `update` on an error/skipped outcome is a previously prepared update, NOT proof
/// that this check succeeded. Only `current` means a successful fresh no-update check.
#[derive(Debug, Clone, Serialize)]
pub struct ChannelOutcome<T> {
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl<T> ChannelOutcome<T> {
    pub fn available(update: T) -> Self {
        Self {
            status: Status::Available,
            update: Some(update),
            reason: None,
        }
    }

    pub fn current() -> Self {
        Self {
            status: Status::Current,
            update: None,
            reason: None,
        }
    }

    pub fn skipped(reason: impl Into<String>) -> Self {
        Self {
            status: Status::Skipped,
            update: None,
            reason: Some(reason.into()),
        }
    }

    pub fn error(reason: impl Into<String>) -> Self {
        Self {
            status: Status::Error,
            update: None,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckReport {
    pub ui: ChannelOutcome<ota::StagedUpdate>,
    pub shell: ChannelOutcome<app_update::AppUpdate>,
}

impl CheckReport {
    fn skipped(reason: &str) -> Self {
        Self {
            ui: ChannelOutcome::skipped(reason),
            shell: ChannelOutcome::skipped(reason),
        }
    }

    pub fn error(reason: &str) -> Self {
        Self {
            ui: ChannelOutcome::error(reason),
            shell: ChannelOutcome::error(reason),
        }
    }
}

/// One process-wide lock covers BOTH stores and publication. No network operation
/// holds AppState locks. UI commands fail fast rather than blocking the event loop.
/// The boolean latches a confirmed restart/install handoff until process exit, since
/// app.exit() can return before the event loop has actually terminated the process.
#[derive(Default)]
pub struct UpdateGate(Mutex<bool>);

impl UpdateGate {
    pub const fn new() -> Self {
        Self(Mutex::new(false))
    }

    pub fn begin(&self) -> Result<MutexGuard<'_, bool>, &'static str> {
        let guard = self.0.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => "update_in_progress",
            TryLockError::Poisoned(_) => "update_lock_poisoned",
        })?;
        if *guard {
            return Err("restart_or_install_pending");
        }
        Ok(guard)
    }
}

pub static OPERATIONS: UpdateGate = UpdateGate::new();

pub(crate) fn guarded(gate: &UpdateGate, check: impl FnOnce() -> CheckReport) -> CheckReport {
    let _operation = match gate.begin() {
        Ok(guard) => guard,
        Err("update_lock_poisoned") => return CheckReport::error("update_lock_poisoned"),
        Err(reason) => return CheckReport::skipped(reason),
    };
    check()
}

/// Never turn a failed refresh into "up to date", even with a cached payload.
pub(crate) fn reconcile<T>(
    result: Result<ChannelOutcome<T>, String>,
    pending: Option<T>,
) -> ChannelOutcome<T> {
    let mut outcome = result.unwrap_or_else(ChannelOutcome::error);
    if outcome.update.is_none() {
        outcome.update = pending;
    }
    if outcome.status == Status::Current && outcome.update.is_some() {
        outcome.status = Status::Available;
        outcome.reason = Some("prepared_update_retained".into());
    }
    outcome
}

/// Blocking work: called only on a worker thread (manual IPC uses spawn_blocking).
/// UI OTA keeps its existing policy: unlike shell updates it is not dev-disabled.
pub fn check(app: &tauri::AppHandle, include_ui: bool) -> CheckReport {
    guarded(&OPERATIONS, || check_locked(app, include_ui))
}

fn check_locked(app: &tauri::AppHandle, include_ui: bool) -> CheckReport {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    let (Some(url), Some(token)) = (config.server_url, config.token) else {
        return CheckReport::skipped("no_credentials");
    };
    let data = match app.path().app_data_dir() {
        Ok(data) => data,
        Err(_) => return CheckReport::error("app_data_directory_unavailable"),
    };
    let ui = if include_ui {
        check_ui(&url, &token, &ota::UiStore::new(&data))
    } else {
        ChannelOutcome::skipped("not_scheduled")
    };
    let shell = check_shell(app, &url, &token, &app_update::UpdateStore::new(&data));
    let report = CheckReport { ui, shell };
    publish(app, &report);
    report
}

pub(crate) fn check_ui(
    url: &str,
    token: &str,
    store: &ota::UiStore,
) -> ChannelOutcome<ota::StagedUpdate> {
    let result = ota::check_and_stage(url, token, store).map(|update| match update {
        Some(update) => ChannelOutcome::available(update),
        None => ChannelOutcome::current(),
    });
    reconcile(result, store.pending_update())
}

fn check_shell(
    app: &tauri::AppHandle,
    url: &str,
    token: &str,
    store: &app_update::UpdateStore,
) -> ChannelOutcome<app_update::AppUpdate> {
    let version = app.package_info().version.to_string();
    let disabled = app_update::check_disabled_reason(
        std::env::var("CORTEX_APP_UPDATE_DISABLE").ok().as_deref(),
        std::env::var("CORTEX_FRONTEND_DIR").ok().as_deref(),
        &version,
    );
    if let Some(reason) = disabled {
        return ChannelOutcome::skipped(reason);
    }
    // Where this build actually lives decides BOTH which asset to fetch and whether it may be
    // installed without asking. Probed once per check so the two answers cannot disagree.
    let site = install_site::detect();
    let capability = install_site::silent_capability(&site);
    let plan = apply_plan(&capability, &PrefsStore::new(store.root()).load());
    shell_log!(
        "[cortex-desktop] install site: {site:?} capability={} plan={plan}",
        capability.label()
    );
    let pending = app.state::<AppState>().app_update.lock().unwrap().clone();
    let pending = pending.filter(|update| app_update::verified(update));
    reconcile(
        app_update::check_and_prepare(
            url,
            token,
            &version,
            app_update::OS_NAME,
            app_update::ARCH_NAME,
            install_site::wanted_kind_for(&site),
            plan,
            store,
        ),
        pending,
    )
}

/// `silent` when this update will install itself on the next quit, `prompt` when the user has to
/// act. The SPA keys its modal-versus-toast choice off this and nothing else.
fn apply_plan(capability: &Apply, prefs: &UpdatePrefs) -> &'static str {
    let silent = install_site::should_apply_silently(
        capability,
        prefs.silent,
        std::env::var("CORTEX_APP_UPDATE_SILENT").ok().as_deref(),
        prefs.failed_attempts,
    );
    if silent {
        "silent"
    } else {
        "prompt"
    }
}

fn publish(app: &tauri::AppHandle, report: &CheckReport) {
    *app.state::<AppState>().app_update.lock().unwrap() = report.shell.update.clone();
    emit_available(app, "frontend-update-staged", &report.ui);
    emit_available(app, "app-update-available", &report.shell);
}

fn emit_available<T: Serialize + Clone>(
    app: &tauri::AppHandle,
    event: &str,
    outcome: &ChannelOutcome<T>,
) {
    if outcome.status != Status::Available {
        return;
    }
    if let Some(update) = &outcome.update {
        if app.emit(event, update).is_err() {
            // Do not log event errors or payloads: URLs/paths may contain private data.
            shell_log!(
                "[cortex-desktop] update event delivery failed; query backstop is available"
            );
        }
    }
}

/// IPC never installs or restarts. Each allowed invocation performs new HTTP reads;
/// overlaps return explicit skipped outcomes instead of replaying a cached report.
#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> CheckReport {
    tauri::async_runtime::spawn_blocking(move || check(&app, true))
        .await
        .unwrap_or_else(|_| CheckReport::error("update_worker_failed"))
}

/// Missed-event backstop. Pending UI files are immutable during rechecks, and the
/// staged version marker is written last, so this does not wait on network I/O.
#[tauri::command]
pub fn get_staged_update(app: tauri::AppHandle) -> Option<ota::StagedUpdate> {
    let data = app.path().app_data_dir().ok()?;
    ota::UiStore::new(&data).pending_update()
}

#[tauri::command]
pub fn get_app_update(state: tauri::State<AppState>) -> Option<app_update::AppUpdate> {
    state.app_update.lock().unwrap().clone()
}

/// User-confirmed only. Refuse a restart while staging/downloading, rather than
/// killing a worker halfway through its store mutation. Android exits for reopen.
#[tauri::command]
pub fn apply_frontend_update(app: tauri::AppHandle) -> Result<(), String> {
    let mut operation = OPERATIONS.begin()?;
    *operation = true;
    #[cfg(target_os = "android")]
    {
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    app.restart()
}

/// User-confirmed only. Hashing and installation share the check guard and run off
/// the event loop. Assisted installs copy to Downloads before releasing the guard.
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || install_locked(&app))
        .await
        .map_err(|_| "update_worker_failed".to_string())?
}

fn install_locked(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let mut operation = OPERATIONS.begin()?;
    let update = app
        .state::<AppState>()
        .app_update
        .lock()
        .unwrap()
        .clone()
        .ok_or("no app update prepared")?;
    if !app_update::verified(&update) {
        return Err("update file failed verification".into());
    }
    let result = app_update::install(app, &update)?;
    // Direct handoffs may still be reading the original file after install returns
    // (including Android's package installer). Do not replace it until next launch.
    *operation = result.is_none();
    Ok(result)
}

/// Do not discard the prepared update if persisting the user's skip fails.
#[tauri::command]
pub fn skip_app_update(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let _operation = OPERATIONS.begin()?;
    let mut pending = state.app_update.lock().unwrap();
    skip_prepared(&mut pending, |version| {
        let data = app
            .path()
            .app_data_dir()
            .map_err(|_| "app_data_directory_unavailable")?;
        app_update::UpdateStore::new(&data)
            .set_skipped(version)
            .map_err(|e| format!("could not save skipped version: {}", e.kind()))
    })
}

pub(crate) fn skip_prepared(
    pending: &mut Option<app_update::AppUpdate>,
    persist: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let Some(update) = pending.as_ref() else {
        return Ok(());
    };
    persist(&update.version)?;
    *pending = None;
    Ok(())
}

/// The prefs file lives beside the downloaded installers, so it needs the same data dir.
fn prefs_store(app: &tauri::AppHandle) -> Option<PrefsStore> {
    let data = app.path().app_data_dir().ok()?;
    Some(PrefsStore::new(app_update::UpdateStore::new(&data).root()))
}

#[tauri::command]
pub fn get_update_prefs(app: tauri::AppHandle) -> UpdatePrefs {
    prefs_store(&app).map(|s| s.load()).unwrap_or_default()
}

/// Turning silent updating back on also clears the failure counter: the user is explicitly asking
/// for another try, and the previous failures may well have been a transient disk or network state.
#[tauri::command]
pub fn set_update_silent(app: tauri::AppHandle, silent: bool) -> Result<UpdatePrefs, String> {
    let store = prefs_store(&app).ok_or("app_data_directory_unavailable")?;
    Ok(store.update(|p| {
        p.silent = silent;
        if silent {
            p.failed_attempts = 0;
        }
    }))
}

/// Install a prepared update on the way out, with no interaction at all.
///
/// Called from `RunEvent::Exit`. The user has already asked to leave, so nothing here may wait on
/// them: only `Apply::Auto` sites qualify. An elevated (polkit) or assisted (open the file) install
/// would put a password box or a file manager in front of someone who is closing the app, which is
/// precisely the failure mode silent updating exists to avoid.
pub fn apply_pending_on_exit(app: &tauri::AppHandle) {
    // Either a check is still running or an install/restart was already confirmed. Both mean this
    // is not our moment, and the gate is the single arbiter of that.
    let Ok(_operation) = OPERATIONS.begin() else {
        return;
    };
    let Some(update) = app.state::<AppState>().app_update.lock().unwrap().clone() else {
        return;
    };
    let Some(prefs_store) = prefs_store(app) else {
        return;
    };
    let prefs = prefs_store.load();
    let site = install_site::detect();
    let capability = install_site::silent_capability(&site);
    if !install_site::should_apply_silently(
        &capability,
        prefs.silent,
        std::env::var("CORTEX_APP_UPDATE_SILENT").ok().as_deref(),
        prefs.failed_attempts,
    ) {
        return;
    }
    // Re-hash before replacing anything: the download has been sitting on disk since the check.
    if !app_update::verified(&update) {
        shell_log!("[cortex-desktop] silent install skipped: prepared file failed verification");
        return;
    }
    // relaunch=false — the user asked to quit, so the new version waits for the next launch.
    match app_update::install_auto(app, &update, &site, false) {
        Ok(_) => {
            shell_log!("[cortex-desktop] silent install applied: {}", update.version);
            prefs_store.update(|p| {
                p.failed_attempts = 0;
                p.last_installed_version = Some(update.version.clone());
            });
        }
        Err(e) => {
            // Count it: after MAX_SILENT_FAILURES the plan flips to `prompt` and the dialog takes
            // over, so a permanently broken site cannot loop quietly forever.
            shell_log!("[cortex-desktop] silent install failed: {e}");
            prefs_store.update(|p| p.failed_attempts = p.failed_attempts.saturating_add(1));
        }
    }
}

/// Preserve the old cadence: UI once at startup; shell at startup and daily.
pub fn start_background(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut include_ui = true;
        loop {
            let report = check(&app, include_ui);
            shell_log!(
                "[cortex-desktop] update check: ui={:?}, shell={:?}",
                report.ui.status,
                report.shell.status
            );
            include_ui = false;
            std::thread::sleep(std::time::Duration::from_secs(24 * 60 * 60));
        }
    });
}
