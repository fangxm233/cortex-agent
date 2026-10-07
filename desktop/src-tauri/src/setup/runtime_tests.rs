// Headless tests compile the production runtime implementation without Tauri/GTK.
#[path = "runtime.rs"]
mod runtime;

use runtime::*;
use std::path::Path;

#[test]
fn release_targets_are_pinned_and_unsupported_targets_refuse() {
    for (os, arch) in [("macos", "x86_64"), ("macos", "aarch64"), ("linux", "x86_64"), ("linux", "aarch64")] {
        let release = release_for(os, arch).unwrap();
        assert!(release.archive.contains("v24.21.0"));
        assert_eq!(release.sha256.len(), 64);
    }
    assert!(release_for("windows", "x86_64").unwrap_err().starts_with("RUNTIME_UNSUPPORTED"));
    assert!(release_for("linux", "riscv64").is_err());
}

#[test]
fn archive_paths_and_relative_npm_links_stay_inside_root() {
    assert!(safe_member(Path::new("node/bin/npm"), "node").is_ok());
    for name in ["/node/bin/node", "node/../escape", "other/bin/node"] {
        assert!(safe_member(Path::new(name), "node").is_err(), "{name}");
    }
    assert!(safe_link(Path::new("bin/npm"), Path::new("../lib/node_modules/npm/bin/npm-cli.js")).is_ok());
    for target in ["../../escape", "/tmp/escape"] {
        assert!(safe_link(Path::new("bin/npm"), Path::new(target)).is_err());
    }
}

#[test]
fn selection_roundtrip_and_missing_runtime_never_fall_back() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    assert!(Selection::load(home).unwrap().is_none());
    let node = home.join("node");
    let npm = home.join("npm");
    std::fs::write(&node, "fixture").unwrap();
    std::fs::write(&npm, "fixture").unwrap();
    let selection = Selection::new(node.clone(), npm, home.join("runtime/prefix"));
    selection.save(home).unwrap();
    assert_eq!(Selection::load(home).unwrap().unwrap().node, node);
    std::fs::remove_file(node).unwrap();
    assert!(Selection::load(home).unwrap_err().starts_with("RUNTIME_MISSING"));
}

#[test]
fn selected_node_and_private_prefix_precede_changing_login_path() {
    let selection = Selection::new("/chosen/bin/node".into(), "/chosen/bin/npm".into(), "/private/prefix".into());
    let path = selection.path(std::ffi::OsStr::new("/other/bin:/usr/bin")).unwrap();
    let parts: Vec<_> = std::env::split_paths(&path).collect();
    assert_eq!(parts[0], Path::new("/chosen/bin"));
    assert_eq!(parts[1], Path::new("/private/prefix/bin"));
}

#[test]
fn cancellation_is_owned_and_does_not_poison_next_install() {
    let owner = InstallGuard::begin().unwrap();
    assert!(InstallGuard::begin().is_err());
    cancel_install();
    assert_eq!(owner.token().check().unwrap_err(), "SETUP_CANCELLED");
    drop(owner);
    cancel_install();
    assert!(InstallGuard::begin().unwrap().token().check().is_ok());
}
