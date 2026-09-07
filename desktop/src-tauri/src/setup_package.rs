// input:  package override, filesystem, reported server version
// output: validated npm package selection and version floor checks
// pos:    Package policy for the local setup wizard
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

use std::ffi::{OsStr, OsString};
use std::path::Path;

const PACKAGE_OVERRIDE: &str = "CORTEX_SETUP_SERVER_PACKAGE";
const DEFAULT_PACKAGE: &str = "@cortex-agent/server@latest";

pub(super) fn server_package() -> Result<OsString, String> {
    select_server_package(std::env::var_os(PACKAGE_OVERRIDE).as_deref())
}

fn select_server_package(package: Option<&OsStr>) -> Result<OsString, String> {
    let Some(package) = package else {
        return Ok(DEFAULT_PACKAGE.into());
    };
    let path = Path::new(package);
    if !path.is_absolute() || path.extension() != Some(OsStr::new("tgz")) || !path.is_file() {
        return Err(format!(
            "{PACKAGE_OVERRIDE} must be an absolute path to an existing .tgz file"
        ));
    }
    Ok(package.to_owned())
}

pub(super) fn validate_server_version(version: Option<&str>) -> Result<(), String> {
    if version.is_some_and(|v| super::version_at_least(v, super::MIN_SERVER_VERSION)) {
        return Ok(());
    }
    Err(format!(
        "Installed server version {} does not meet the required minimum {}",
        version.unwrap_or("unknown"),
        super::MIN_SERVER_VERSION
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_defaults_to_latest_only_when_override_is_absent() {
        assert_eq!(
            select_server_package(None).unwrap(),
            OsString::from(DEFAULT_PACKAGE)
        );
        assert!(select_server_package(Some(OsStr::new(""))).is_err());
    }

    #[test]
    fn package_override_accepts_an_absolute_existing_tarball_with_spaces() {
        let path =
            std::env::temp_dir().join(format!("cortex setup package {}.tgz", std::process::id()));
        std::fs::write(&path, b"disposable package selection fixture").unwrap();
        let selected = select_server_package(Some(path.as_os_str()));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(selected.unwrap(), path.into_os_string());
    }

    #[test]
    fn invalid_package_overrides_never_fall_back_to_npm() {
        for package in [
            "relative.tgz",
            "@cortex-agent/server@latest",
            "https://example.com/server.tgz",
        ] {
            let error = select_server_package(Some(OsStr::new(package))).unwrap_err();
            assert!(error.contains(PACKAGE_OVERRIDE));
        }
        let missing =
            std::env::temp_dir().join(format!("cortex-missing-{}.tgz", std::process::id()));
        assert!(select_server_package(Some(missing.as_os_str())).is_err());
    }

    #[test]
    fn package_override_rejects_directories_and_other_extensions() {
        let path =
            std::env::temp_dir().join(format!("cortex-package-dir-{}.tgz", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        let selected = select_server_package(Some(path.as_os_str()));
        std::fs::remove_dir(&path).unwrap();
        assert!(selected.is_err());
        let path = std::env::temp_dir().join(format!("cortex-package-{}.zip", std::process::id()));
        std::fs::write(&path, b"not a tarball").unwrap();
        let selected = select_server_package(Some(path.as_os_str()));
        std::fs::remove_file(&path).unwrap();
        assert!(selected.is_err());
    }

    #[test]
    fn installed_version_must_be_reported_and_meet_the_floor() {
        for version in [None, Some(""), Some("unknown"), Some("2026.8.19")] {
            let error = validate_server_version(version).unwrap_err();
            assert!(error.contains(super::super::MIN_SERVER_VERSION));
        }
        assert!(validate_server_version(Some(super::super::MIN_SERVER_VERSION)).is_ok());
        assert!(validate_server_version(Some("2026.8.20-2")).is_ok());
        assert!(validate_server_version(Some("2026.10.1")).is_ok());
    }
}
