// Credential store — the connection config (serverUrl + token) the SPA needs to reach the Cortex
// server, kept as JSON in the app's private data directory (`app_data_dir()/connection.json`) on
// every platform. On Unix the file is created owner-only (0600).
//
// Desktop builds used to keep this in the OS keychain. An ad-hoc signed macOS app loses access to
// its own keychain item on every update, so macOS asked for the login password after each upgrade.
// The keychain is now only read once, to import a connection saved by an older build (`legacy`).

use crate::connection::ConnectionConfig;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "connection.json";

fn creds_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME))
}

/// Load credentials. None when no usable connection is stored.
pub fn load(app: &AppHandle) -> Option<ConnectionConfig> {
    let path = creds_path(app)?;
    if path.exists() {
        return read_file(&path);
    }
    import_legacy(&path, legacy::read, legacy::forget)
}

/// Persist credentials, creating the data directory if needed.
pub fn save(app: &AppHandle, config: &ConnectionConfig) -> Result<(), String> {
    let path = creds_path(app).ok_or_else(|| "no app_data_dir".to_string())?;
    write_file(&path, config)
}

/// Delete the stored credentials (best-effort; errors ignored).
pub fn clear(app: &AppHandle) {
    if let Some(path) = creds_path(app) {
        let _ = std::fs::remove_file(path);
    }
    legacy::forget();
}

/// One-line diagnostic of the credential file state (logged at startup), so "never saved" and
/// "present but unusable" can be told apart when a launch lands on the connect screen.
pub fn diagnostics(app: &AppHandle) -> String {
    match creds_path(app) {
        None => "creds backend=file path=unavailable(no app_data_dir)".to_string(),
        Some(path) => describe(&path),
    }
}

fn describe(path: &Path) -> String {
    let len = std::fs::metadata(path).map(|m| m.len()).ok();
    format!(
        "creds backend=file path={} exists={} len={} usable={}",
        path.display(),
        len.is_some(),
        len.unwrap_or(0),
        read_file(path).is_some()
    )
}

fn usable(config: ConnectionConfig) -> Option<ConnectionConfig> {
    (config.server_url.is_some() && config.token.is_some()).then_some(config)
}

fn read_file(path: &Path) -> Option<ConnectionConfig> {
    let data = std::fs::read_to_string(path).ok()?;
    usable(serde_json::from_str(&data).ok()?)
}

fn write_file(path: &Path, config: &ConnectionConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let data = serde_json::to_string(config).map_err(|e| format!("serialize: {e}"))?;
    let mut file = owner_only().open(path).map_err(|e| format!("open: {e}"))?;
    file.write_all(data.as_bytes()).map_err(|e| format!("write: {e}"))
}

fn owner_only() -> std::fs::OpenOptions {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
}

/// Move a connection saved by an older build into the file. The old entry is removed only once the
/// file holds it, so a failed write leaves it to be imported on the next launch.
fn import_legacy(
    path: &Path,
    read: impl FnOnce() -> Option<ConnectionConfig>,
    forget: impl FnOnce(),
) -> Option<ConnectionConfig> {
    let config = usable(read()?)?;
    if write_file(path, &config).is_ok() {
        forget();
    }
    Some(config)
}

/// The keychain entry desktop builds wrote before the file store existed.
#[cfg(not(target_os = "android"))]
mod legacy {
    use crate::connection::ConnectionConfig;

    const SERVICE: &str = "dev.cortex.desktop";
    const ACCOUNT: &str = "connection";

    fn entry() -> Option<keyring::Entry> {
        keyring::Entry::new(SERVICE, ACCOUNT).ok()
    }

    pub fn read() -> Option<ConnectionConfig> {
        serde_json::from_str(&entry()?.get_password().ok()?).ok()
    }

    pub fn forget() {
        if let Some(entry) = entry() {
            let _ = entry.delete_credential();
        }
    }
}

/// Android always stored the file.
#[cfg(target_os = "android")]
mod legacy {
    use crate::connection::ConnectionConfig;

    pub fn read() -> Option<ConnectionConfig> {
        None
    }

    pub fn forget() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn remote(token: &str) -> ConnectionConfig {
        ConnectionConfig {
            server_url: Some("https://cortex.example.com".into()),
            token: Some(token.into()),
            ..ConnectionConfig::default()
        }
    }

    #[test]
    fn saved_credentials_load_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(FILE_NAME);
        write_file(&path, &remote("t1")).unwrap();
        write_file(&path, &remote("t2")).unwrap();
        assert_eq!(read_file(&path).unwrap().token.as_deref(), Some("t2"));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        write_file(&path, &remote("t")).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn incomplete_or_corrupt_files_are_not_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, r#"{"serverUrl":"https://cortex.example.com"}"#).unwrap();
        assert!(read_file(&path).is_none());
        std::fs::write(&path, "{").unwrap();
        assert!(read_file(&path).is_none());
    }

    #[test]
    fn a_legacy_entry_moves_into_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let forgotten = Cell::new(false);
        let loaded = import_legacy(&path, || Some(remote("old")), || forgotten.set(true));
        assert_eq!(loaded.unwrap().token.as_deref(), Some("old"));
        assert_eq!(read_file(&path).unwrap().token.as_deref(), Some("old"));
        assert!(forgotten.get());
    }

    #[test]
    fn a_legacy_entry_is_kept_when_the_file_cannot_be_written() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, "").unwrap();
        let forgotten = Cell::new(false);
        let loaded = import_legacy(&blocker.join(FILE_NAME), || Some(remote("old")), || forgotten.set(true));
        assert!(loaded.is_some(), "this launch still connects");
        assert!(!forgotten.get());
    }

    #[test]
    fn an_unusable_legacy_entry_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let blank = ConnectionConfig::default();
        assert!(import_legacy(&path, || Some(blank), || panic!("nothing to forget")).is_none());
        assert!(!path.exists());
    }
}
