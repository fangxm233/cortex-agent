//! Anonymous telemetry, native half: the per-install id the shell shares with the server it sets
//! up, and shell panics. The release profile aborts on panic, so a panic cannot be sent while it
//! happens: the hook writes it to `<app data>/telemetry/native-crash.json` and the web UI takes
//! it on the next launch (`telemetry_take_native_crash`) and reports it through its server.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

const CRASH_FILE: &str = "native-crash.json";
const INSTALL_ID_FILE: &str = "install-id";
const MAX_MESSAGE: usize = 2_000;
const MAX_STACK: usize = 20_000;

/// A panic recorded on an earlier run, in the shape `telemetry.report {kind:'native_crash'}` takes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCrash {
    pub at: String,
    pub message: String,
    pub stack: String,
    pub app_version: String,
}

/// `<app data>/telemetry`, the shell's own telemetry files.
pub fn telemetry_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("telemetry"))
}

fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok() && value.len() == 36
}

/// The random install id, created on first use. Carries no machine or user information.
pub fn install_id(dir: &Path) -> String {
    let file = dir.join(INSTALL_ID_FILE);
    if let Ok(saved) = std::fs::read_to_string(&file) {
        let saved = saved.trim().to_ascii_lowercase();
        if is_uuid(&saved) {
            return saved;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&file, format!("{id}\n")));
    id
}

/// UTC `YYYY-MM-DDTHH:MM:SS.mmmZ` without a date library (civil-from-days).
pub fn iso_utc(time: std::time::SystemTime) -> String {
    let since = time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600, rem % 3_600 / 60, rem % 60, since.subsec_millis()
    )
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Replace the user's home directory so a panic message or backtrace names no account.
pub fn redact_home(text: &str, home: Option<&str>) -> String {
    match home.filter(|h| h.len() > 1) {
        Some(home) => text.replace(home, "~"),
        None => text.to_string(),
    }
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()
}

fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    let text = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".to_string());
    match info.location() {
        Some(at) => format!("{text} at {}:{}:{}", at.file(), at.line(), at.column()),
        None => text,
    }
}

/// The crash record for one panic, redacted and cut to the report limits.
pub fn crash_record(message: &str, backtrace: &str, version: &str, home: Option<&str>) -> NativeCrash {
    NativeCrash {
        at: iso_utc(std::time::SystemTime::now()),
        message: truncate(&redact_home(message, home), MAX_MESSAGE),
        stack: truncate(&redact_home(backtrace, home), MAX_STACK),
        app_version: truncate(version, 40),
    }
}

pub fn write_crash(dir: &Path, crash: &NativeCrash) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_string(crash).map_err(std::io::Error::other)?;
    std::fs::write(dir.join(CRASH_FILE), json)
}

/// The recorded panic, removed as it is read. A corrupt file is discarded.
pub fn take_crash(dir: &Path) -> Option<NativeCrash> {
    let file = dir.join(CRASH_FILE);
    let raw = std::fs::read_to_string(&file).ok()?;
    let _ = std::fs::remove_file(&file);
    serde_json::from_str(&raw).ok()
}

/// Record every panic before the default hook runs (and, in release, the process aborts).
pub fn install_panic_hook(dir: PathBuf, version: String) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let crash = crash_record(&panic_message(info), &backtrace, &version, home_dir().as_deref());
        let _ = write_crash(&dir, &crash);
        previous(info);
    }));
}

/// The panic an earlier run recorded, if any; the file is gone afterwards.
#[tauri::command]
pub fn telemetry_take_native_crash(app: tauri::AppHandle) -> Option<NativeCrash> {
    take_crash(&telemetry_dir(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cortex-telemetry-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_recorded_crash_is_taken_once() {
        let dir = tmp("crash");
        let crash = crash_record("boom at src/lib.rs:1:1", "0: frame", "2026.10.24", None);
        write_crash(&dir, &crash).unwrap();
        assert_eq!(take_crash(&dir), Some(crash));
        assert_eq!(take_crash(&dir), None);
    }

    #[test]
    fn a_corrupt_crash_file_is_discarded() {
        let dir = tmp("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(CRASH_FILE), "{not json").unwrap();
        assert_eq!(take_crash(&dir), None);
        assert!(!dir.join(CRASH_FILE).exists());
    }

    #[test]
    fn the_home_directory_never_reaches_the_record() {
        let crash = crash_record(
            "failed to read /home/alice/.cortex/x.json",
            "at /home/alice/src/main.rs:3",
            "1.0",
            Some("/home/alice"),
        );
        assert_eq!(crash.message, "failed to read ~/.cortex/x.json");
        assert_eq!(crash.stack, "at ~/src/main.rs:3");
    }

    #[test]
    fn the_record_is_cut_to_the_report_limits() {
        let crash = crash_record(&"m".repeat(5_000), &"s".repeat(50_000), &"v".repeat(80), None);
        assert_eq!(crash.message.len(), MAX_MESSAGE);
        assert_eq!(crash.stack.len(), MAX_STACK);
        assert_eq!(crash.app_version.len(), 40);
    }

    #[test]
    fn the_record_serializes_as_the_web_report_fields() {
        let crash = crash_record("boom", "", "1.0", None);
        let json = serde_json::to_value(&crash).unwrap();
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["appVersion", "at", "message", "stack"]);
    }

    #[test]
    fn the_install_id_is_created_once_and_kept() {
        let dir = tmp("id");
        let id = install_id(&dir);
        assert!(is_uuid(&id));
        assert_eq!(install_id(&dir), id);
        std::fs::write(dir.join(INSTALL_ID_FILE), "not-a-uuid").unwrap();
        assert_ne!(install_id(&dir), id);
    }

    #[test]
    fn timestamps_are_iso_utc() {
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_761_300_000_123);
        assert_eq!(iso_utc(at), "2025-10-24T10:00:00.123Z");
        assert_eq!(iso_utc(std::time::UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }
}
