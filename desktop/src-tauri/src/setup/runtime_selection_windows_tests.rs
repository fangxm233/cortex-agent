//! Pure Windows layout policy, not a Windows execution qualification.
use super::selection_discovery::{find_windows_bin, npm_cli_layout};
use super::selection_environment::{prefix_bin_for, windows_paths};
use super::*;

fn touch(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "fixture").unwrap();
}

fn windows_selection(root: &Path) -> Selection {
    Selection::new(
        root.join("node/node.exe"),
        root.join("node/npm.cmd"),
        root.join("prefix"),
    )
}

#[test]
fn windows_layout_prefix_is_flat_and_paths_pin_only_same_root_tools() {
    let root = tempfile::tempdir().unwrap();
    let mut selected = windows_selection(root.path());
    let git = root.path().join("Git");
    for name in [
        "cmd/git.exe",
        "usr/bin/bash.exe",
        "usr/bin/sh.exe",
        "usr/bin/grep.exe",
    ] {
        touch(&git.join(name));
    }
    selected.git = GitSelection::from_root(git.clone(), false);
    assert_eq!(prefix_bin_for(&selected.prefix, true), selected.prefix);
    assert_eq!(
        prefix_bin_for(&selected.prefix, false),
        selected.prefix.join("bin")
    );
    assert_eq!(
        windows_paths(&selected).unwrap(),
        vec![
            root.path().join("node"),
            selected.prefix.clone(),
            git.join("cmd"),
            git.join("usr/bin")
        ]
    );
    assert!(!root.path().join("bin").exists());
}

#[test]
fn windows_lookup_prefers_native_suffixes_over_bash_npm_script() {
    let root = tempfile::tempdir().unwrap();
    for name in ["node", "node.exe", "npm", "npm.cmd", "git.exe"] {
        touch(&root.path().join(name));
    }
    for (name, file) in [
        ("node", "node.exe"),
        ("npm", "npm.cmd"),
        ("npm.cmd", "npm.cmd"),
    ] {
        assert_eq!(
            find_windows_bin(name, root.path().as_os_str()),
            Some(root.path().join(file))
        );
    }
    assert!(find_windows_bin("bash", root.path().as_os_str()).is_none());
}

#[test]
fn windows_git_layout_rejects_bare_git_mingit_and_unrelated_bash() {
    let root = tempfile::tempdir().unwrap();
    touch(&root.path().join("cmd/git.exe"));
    touch(&root.path().join("bin/bash.exe"));
    assert!(GitSelection::from_root(root.path().into(), false).is_none());
    for name in ["usr/bin/bash.exe", "usr/bin/sh.exe", "usr/bin/grep.exe"] {
        touch(&root.path().join(name));
    }
    let mut git = GitSelection::from_root(root.path().into(), false).unwrap();
    assert_eq!(git.bash, root.path().join("usr/bin/bash.exe"));
    git.bash = root.path().join("bin/bash.exe");
    assert!(git.validate().is_err());
}

pub(super) fn npm_layout(selected: &Selection) -> PathBuf {
    let dir = selected.node.parent().unwrap();
    let package = dir.join("node_modules/npm");
    touch(&selected.node);
    touch(&package.join("bin/npm-cli.js"));
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"npm","bin":{"npm":"bin/npm-cli.js"}}"#,
    )
    .unwrap();
    let cmd = "SET \"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js\"\n";
    let shell = "NPM_CLI_JS=\"$CLI_BASEDIR/node_modules/npm/bin/npm-cli.js\"\n";
    for (name, contents) in [("npm.cmd", cmd), ("npm", shell)] {
        std::fs::write(dir.join(name), contents).unwrap();
        std::fs::write(package.join("bin").join(name), contents).unwrap();
    }
    package.join("bin/npm-cli.js")
}

#[test]
fn windows_npm_layout_binds_only_same_install_unmodified_package_shims() {
    let root = tempfile::tempdir().unwrap();
    let mut selected = windows_selection(root.path());
    let cli = npm_layout(&selected);
    assert_eq!(npm_cli_layout(&selected), Some(cli));
    std::fs::write(&selected.npm, "custom shim for unrelated npm").unwrap();
    assert!(npm_cli_layout(&selected).is_none());
    npm_layout(&selected);
    selected.npm = root.path().join("unrelated/npm.cmd");
    touch(&selected.npm);
    assert!(npm_cli_layout(&selected).is_none());
}

#[test]
fn windows_npm_binding_must_precede_launch_and_rejects_stale_identity() {
    let root = tempfile::tempdir().unwrap();
    let mut selected = windows_selection(root.path());
    let cli = npm_layout(&selected);
    assert!(selected.validate_windows_npm().is_err());
    assert!(selected.qualify_windows_npm());
    assert_eq!(selected.npm_cli, Some(cli));
    assert!(selected.validate_windows_npm().is_ok());
    assert!(selected.is_npm_for(OsStr::new("NPM.CMD"), true));
    assert!(selected.is_npm_for(OsStr::new("NPM"), true));
    assert!(!selected.is_npm_for(OsStr::new("NPM"), false));
    selected.npm_cli = Some(root.path().join("unrelated/npm-cli.js"));
    assert!(selected.validate_windows_npm().is_err());
}

#[test]
fn windows_npm_layout_missing_cli_or_shell_shim_is_not_qualified() {
    for missing in ["node_modules/npm/bin/npm-cli.js", "npm"] {
        let root = tempfile::tempdir().unwrap();
        let selected = windows_selection(root.path());
        npm_layout(&selected);
        std::fs::remove_file(selected.node.parent().unwrap().join(missing)).unwrap();
        assert!(npm_cli_layout(&selected).is_none());
    }
}
