// input:  Embedded frontend files and app-private frontend directory
// output: Upgrade-safe frontend with native notification support
// pos:    Android bundled frontend lifecycle
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

use include_dir::{include_dir, Dir};
use sha2::{Digest, Sha256};
use std::{io, path::Path};

static SEED: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../web/dist");
const BRIDGE_MARKER: &str = "name=\"cortex-native-notifications\"";

pub fn ensure_seed(dest: &Path) -> io::Result<bool> {
    let index = SEED.get_file("index.html")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Bundled frontend missing"))?;
    // Vite's index names content-hashed assets. The marker lives outside current/
    // so an OTA replacement does not cause the bundled seed to overwrite it again.
    let version = format!("{:x}", Sha256::digest(index.contents()));
    ensure_version(dest, &version, || SEED.extract(dest))
}

fn ensure_version(dest: &Path, version: &str, extract: impl FnOnce() -> io::Result<()>) -> io::Result<bool> {
    let marker = dest.with_extension("seed-version");
    // Older servers may cache a frontend without the native action consumer.
    // Preserve compatible OTA builds, but never strand taps behind a legacy page.
    let compatible = std::fs::read_to_string(dest.join("index.html"))
        .map(|html| html.contains(BRIDGE_MARKER)).unwrap_or(false);
    if compatible && std::fs::read_to_string(&marker).ok().as_deref() == Some(version) {
        return Ok(false);
    }
    std::fs::create_dir_all(dest)?;
    extract()?;
    let staged = marker.with_extension("seed-version.tmp");
    std::fs::write(&staged, version)?;
    std::fs::rename(staged, marker)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sandbox() -> std::path::PathBuf {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("cortex-seed-{}-{unique}", std::process::id())).join("current")
    }
    fn install(dest: &Path, version: &str) -> io::Result<bool> {
        ensure_version(dest, version, || std::fs::write(dest.join("index.html"), format!("{version}{BRIDGE_MARKER}")))
    }
    #[test]
    fn installs_first_run_and_apk_upgrade() {
        let dest = sandbox();
        assert!(install(&dest, "first").unwrap());
        assert!(!install(&dest, "first").unwrap());
        assert!(install(&dest, "second").unwrap());
        assert_eq!(std::fs::read_to_string(dest.join("index.html")).unwrap(), format!("second{BRIDGE_MARKER}"));
        std::fs::remove_dir_all(dest.parent().unwrap()).unwrap();
    }
    #[test]
    fn preserves_ota_until_bundled_frontend_changes() {
        let dest = sandbox();
        install(&dest, "seed").unwrap();
        std::fs::write(dest.join("index.html"), format!("ota{BRIDGE_MARKER}")).unwrap();
        assert!(!install(&dest, "seed").unwrap());
        assert_eq!(std::fs::read_to_string(dest.join("index.html")).unwrap(), format!("ota{BRIDGE_MARKER}"));
        std::fs::remove_file(dest.join("index.html")).unwrap();
        assert!(install(&dest, "seed").unwrap());
        std::fs::remove_dir_all(dest.parent().unwrap()).unwrap();
    }
    #[test]
    fn restores_notification_bridge_after_legacy_ota() {
        let dest = sandbox();
        install(&dest, "seed").unwrap();
        std::fs::write(dest.join("index.html"), "legacy-ota").unwrap();
        assert!(install(&dest, "seed").unwrap());
        std::fs::remove_dir_all(dest.parent().unwrap()).unwrap();
    }
    #[test]
    fn upgrades_legacy_install_without_marker() {
        let dest = sandbox();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("index.html"), "legacy").unwrap();
        assert!(install(&dest, "seed").unwrap());
        std::fs::remove_dir_all(dest.parent().unwrap()).unwrap();
    }
    #[test]
    fn failed_extraction_does_not_mark_upgrade_complete() {
        let dest = sandbox();
        install(&dest, "old").unwrap();
        assert!(ensure_version(&dest, "new", || Err(io::Error::other("interrupted"))).is_err());
        assert_eq!(std::fs::read_to_string(dest.with_extension("seed-version")).unwrap(), "old");
        assert!(install(&dest, "new").unwrap());
        std::fs::remove_dir_all(dest.parent().unwrap()).unwrap();
    }
}
