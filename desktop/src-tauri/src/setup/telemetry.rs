//! The desktop setup funnel. Before a server exists nothing else can report how setup went, so
//! the shell posts these few steps itself, straight to the endpoint the release build was given
//! (`CORTEX_TELEMETRY_ENDPOINT` at compile time; none compiled in → nothing is ever sent).
//!
//! Each step goes once per install and carries a failure class, never error text. The steps are
//! sent unless `CORTEX_TELEMETRY=0` or `DO_NOT_TRACK` in the shell's environment silences them, as
//! they do the server; the user's choice is offered after install, by the server it sets up.
//! Sending is fire-and-forget on its own thread with a short timeout; it can neither block nor fail
//! setup.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

const ENDPOINT: Option<&str> = option_env!("CORTEX_TELEMETRY_ENDPOINT");
const STATE_FILE: &str = "setup.json";
const SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// One file read-modify-write at a time: setup commands run on blocking worker threads.
static STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Step {
    SetupStarted,
    ServerInstalled,
    ServerInstallFailed,
    InitCompleted,
    InitFailed,
    DaemonStarted,
    DaemonStartFailed,
}

impl Step {
    /// The `DESKTOP_SETUP_STEPS` name.
    pub fn name(self) -> &'static str {
        match self {
            Step::SetupStarted => "setup_started",
            Step::ServerInstalled => "server_installed",
            Step::ServerInstallFailed => "server_install_failed",
            Step::InitCompleted => "init_completed",
            Step::InitFailed => "init_failed",
            Step::DaemonStarted => "daemon_started",
            Step::DaemonStartFailed => "daemon_start_failed",
        }
    }
}

/// What the shell remembers between launches: the UI language and the steps sent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FunnelState {
    pub lang: Option<String>,
    pub sent: Vec<String>,
}

pub fn load_state(dir: &Path) -> FunnelState {
    std::fs::read_to_string(dir.join(STATE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_state(dir: &Path, state: &FunnelState) {
    let json = serde_json::to_string(state).unwrap_or_default();
    let _ = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(dir.join(STATE_FILE), json));
}

/// Mark `step` sent and say whether it should go out now (not sent before).
pub fn claim_step(dir: &Path, step: Step) -> Option<FunnelState> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = load_state(dir);
    if state.sent.iter().any(|s| s == step.name()) {
        return None;
    }
    state.sent.push(step.name().to_string());
    save_state(dir, &state);
    Some(state)
}

/// Remember the setup screen's language for the steps still to come.
pub fn set_lang(dir: &Path, lang: String) {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = load_state(dir);
    state.lang = Some(lang);
    save_state(dir, &state);
}

/// Error fragments per `SETUP_FAILURE_CLASSES` class, checked in order.
const FAILURE_CLASSES: &[(&str, &[&str])] = &[
    ("cancelled", &["setup_cancelled", "cancelled", "canceled"]),
    ("permission", &["eacces", "eperm", "permission denied", "access is denied"]),
    ("disk", &["enospc", "no space left", "disk full", "not enough space"]),
    ("timeout", &["daemon_timeout", "timed out", "timeout"]),
    ("network", &["enotfound", "econnreset", "econnrefused", "etimedout", "eai_again", "network", "fetch failed", "unable to connect"]),
];

/// The failure class of a setup error. Only the class leaves the machine, never the text.
pub fn failure_class(error: &str) -> &'static str {
    let lower = error.to_ascii_lowercase();
    FAILURE_CLASSES
        .iter()
        .find(|(_, needles)| needles.iter().any(|n| lower.contains(n)))
        .map_or("other", |(class, _)| class)
}

fn os_name() -> &'static str {
    match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "win32",
        "android" => "android",
        _ => "other",
    }
}

/// Node's names for the two architectures the shell ships, so desktop and server rows agree.
fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// The leading number of a release string ("6.8.0-1-generic" → "6", "Version 10.0.2" → "10").
pub fn major_release(raw: &str) -> String {
    raw.split(|c: char| !c.is_ascii_digit())
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .chars()
        .take(20)
        .collect()
}

fn os_release() -> String {
    #[cfg(target_os = "windows")]
    let raw = super::process::probe_output("cmd", &["/c", "ver"]);
    #[cfg(not(target_os = "windows"))]
    let raw = super::process::probe_output("uname", &["-r"]);
    raw.map(|r| major_release(&r)).unwrap_or_default()
}

fn ui_lang(lang: Option<&str>) -> &'static str {
    match lang.map(|l| l.to_ascii_lowercase()) {
        Some(l) if l.starts_with("zh") => "zh",
        Some(l) if l.starts_with("en") => "en",
        _ => "other",
    }
}

/// Host facts that do not change while the shell runs.
#[derive(Clone)]
pub struct Host {
    pub version: String,
    /// `dev` for debug builds of the shell, so they stay out of the default dashboard view.
    pub channel: &'static str,
    pub os: &'static str,
    pub os_release: String,
    pub arch: &'static str,
}

/// One funnel event about to be sent.
pub struct FunnelEvent<'a> {
    pub step: Step,
    pub detail: Option<&'a str>,
    pub lang: Option<&'a str>,
    pub at: &'a str,
}

/// One batch with one funnel event, shaped as `TelemetryBatchSchema`.
pub fn batch_json(host: &Host, install_id: &str, event: &FunnelEvent<'_>) -> serde_json::Value {
    let FunnelEvent { step, detail, lang, at: now } = *event;
    serde_json::json!({
        "envelope": {
            "schema": 1, "installId": install_id, "sentAt": now,
            "version": host.version.chars().take(40).collect::<String>(),
            "channel": host.channel,
            "installForm": "desktop", "os": host.os, "osRelease": host.os_release,
            "arch": host.arch, "nodeMajor": null, "uiLang": ui_lang(lang),
        },
        "events": [{
            "type": "funnel", "at": now, "source": "desktop-setup", "step": step.name(), "detail": detail,
        }],
    })
}

fn post(endpoint: &str, body: serde_json::Value) {
    let Ok(client) = crate::ota::build_http_client_with_timeout(SEND_TIMEOUT) else { return };
    // Best effort: an unreachable endpoint loses this step, nothing more.
    let _ = client.post(endpoint).json(&body).send();
}

fn host(app: &AppHandle) -> Host {
    static HOST: std::sync::OnceLock<Host> = std::sync::OnceLock::new();
    HOST.get_or_init(|| Host {
        version: app.package_info().version.to_string(),
        channel: if cfg!(debug_assertions) { "dev" } else { "release" },
        os: os_name(),
        os_release: os_release(),
        arch: arch_name(),
    })
    .clone()
}

/// `DO_NOT_TRACK` set to anything but empty, `0`, `false`, `no` or `off` (the server's reading).
fn truthy_flag(raw: Option<String>) -> bool {
    let Some(raw) = raw else { return false };
    let value = raw.trim().to_ascii_lowercase();
    !matches!(value.as_str(), "" | "0" | "false" | "no" | "off")
}

/// The environment's hard switches, which win over the setup opt-in as they win over the
/// server's setting.
pub fn env_opts_out(var: impl Fn(&str) -> Option<String>) -> bool {
    let telemetry_off = var("CORTEX_TELEMETRY").is_some_and(|v| v.trim() == "0");
    telemetry_off || truthy_flag(var("DO_NOT_TRACK"))
}

fn funnel_dir(app: &AppHandle) -> Option<PathBuf> {
    ENDPOINT.filter(|e| !e.trim().is_empty())?;
    if env_opts_out(|name| std::env::var(name).ok()) {
        return None;
    }
    crate::telemetry::telemetry_dir(app)
}

/// Report one setup step in the background. `detail` is a failure class or nothing.
pub fn report(app: &AppHandle, step: Step, detail: Option<&'static str>) {
    let (Some(dir), Some(endpoint)) = (funnel_dir(app), ENDPOINT) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(state) = claim_step(&dir, step) else { return };
        let id = crate::telemetry::install_id(&dir);
        let at = crate::telemetry::iso_utc(std::time::SystemTime::now());
        let event = FunnelEvent { step, detail, lang: state.lang.as_deref(), at: &at };
        post(endpoint.trim(), batch_json(&host(&app), &id, &event));
    });
}

/// Report a step's outcome: `ok` on success, `failed` with the error's class otherwise.
pub fn report_outcome<T>(app: &AppHandle, result: &Result<T, String>, ok: Step, failed: Step) {
    match result {
        Ok(_) => report(app, ok, None),
        Err(error) => report(app, failed, Some(failure_class(error))),
    }
}

/// The setup screen's language, told when the install starts so that its steps carry it.
#[tauri::command]
pub fn setup_telemetry_lang(app: AppHandle, lang: String) {
    if let Some(dir) = crate::telemetry::telemetry_dir(&app) {
        set_lang(&dir, lang);
    }
}

/// The `telemetry` field `cortex init` takes: the setting plus the shell's install id, so the
/// server it creates reports under the same id as these setup steps.
pub fn init_answer(app: &AppHandle, enabled: bool) -> serde_json::Value {
    let id = crate::telemetry::telemetry_dir(app).map(|dir| crate::telemetry::install_id(&dir));
    match id {
        Some(id) => serde_json::json!({ "enabled": enabled, "installId": id }),
        None => serde_json::json!({ "enabled": enabled }),
    }
}

#[cfg(test)]
#[path = "telemetry_tests.rs"]
mod tests;
