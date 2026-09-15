// input:  <appDataDir>/updates/prefs.json
// output: UpdatePrefs (silent opt-out, consecutive silent failures, last installed version)
// pos:    Shell-side update preferences — the only state the silent path keeps between runs
//
// Deliberately stored next to `skipped.version` under `<appDataDir>/updates/` rather than in the
// SPA or on the server: the frontend is replaced wholesale by OTA and the server may be a remote
// machine shared by several installs, while this is a property of THIS copy of the app.
//
// Silent updating is ON by default (product decision), so a missing or unreadable file must read
// as "silent enabled" — never as "disabled". Only an explicit `"silent": false` turns it off.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatePrefs {
    /// User-facing toggle. Default true.
    pub silent: bool,
    /// Consecutive failed silent installs; resets on success. Guards against a quiet retry loop.
    #[serde(default, rename = "failedAttempts")]
    pub failed_attempts: u32,
    /// Version of the last successfully applied update, used to raise the "updated to X" notice
    /// exactly once after a silent install lands.
    #[serde(default, rename = "lastInstalledVersion", skip_serializing_if = "Option::is_none")]
    pub last_installed_version: Option<String>,
}

impl Default for UpdatePrefs {
    fn default() -> Self {
        Self {
            silent: true,
            failed_attempts: 0,
            last_installed_version: None,
        }
    }
}

/// Parse stored prefs, falling back to defaults for anything missing or malformed. A corrupt file
/// must not disable updating, so every failure path yields `UpdatePrefs::default()`.
pub fn parse(contents: &str) -> UpdatePrefs {
    serde_json::from_str(contents).unwrap_or_default()
}

pub struct PrefsStore {
    path: PathBuf,
}

impl PrefsStore {
    /// `root` is the update store directory (`<appDataDir>/updates`).
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join("prefs.json"),
        }
    }

    pub fn load(&self) -> UpdatePrefs {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => parse(&text),
            Err(_) => UpdatePrefs::default(),
        }
    }

    pub fn save(&self, prefs: &UpdatePrefs) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(prefs)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(&self.path, text)
    }

    /// Apply `edit` to the stored prefs and persist the result. The updated value is returned even
    /// when persisting fails, so an unwritable disk degrades to "in-memory only" rather than to a
    /// hard error on a background path.
    pub fn update(&self, edit: impl FnOnce(&mut UpdatePrefs)) -> UpdatePrefs {
        let mut prefs = self.load();
        edit(&mut prefs);
        let _ = self.save(&prefs);
        prefs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cortex-prefs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_or_corrupt_prefs_keep_silent_enabled() {
        assert_eq!(parse(""), UpdatePrefs::default());
        assert_eq!(parse("not json"), UpdatePrefs::default());
        assert_eq!(parse("{}"), UpdatePrefs::default());
        assert!(UpdatePrefs::default().silent);
        let dir = tmp();
        assert!(PrefsStore::new(&dir.join("nope")).load().silent);
    }

    #[test]
    fn only_an_explicit_false_disables_silent() {
        assert!(!parse(r#"{"silent":false}"#).silent);
        assert!(parse(r#"{"silent":true}"#).silent);
        // A partial file keeps the other fields at their defaults.
        assert_eq!(parse(r#"{"silent":false}"#).failed_attempts, 0);
    }

    #[test]
    fn round_trips_through_disk_and_edits_in_place() {
        let dir = tmp();
        let store = PrefsStore::new(&dir);
        let saved = store.update(|p| {
            p.silent = false;
            p.failed_attempts = 2;
            p.last_installed_version = Some("2026.9.20".into());
        });
        assert_eq!(store.load(), saved);
        assert!(!store.load().silent);
        assert_eq!(store.load().failed_attempts, 2);
        assert_eq!(store.load().last_installed_version.as_deref(), Some("2026.9.20"));
        store.update(|p| p.failed_attempts = 0);
        assert_eq!(store.load().failed_attempts, 0);
        assert!(!store.load().silent, "unrelated edits must not resurrect the default");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
