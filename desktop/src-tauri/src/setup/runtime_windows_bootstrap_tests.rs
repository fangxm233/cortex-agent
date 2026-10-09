use super::super::Server;
use super::*;

#[test]
fn repair_preserves_good_node_and_server_and_adds_missing_git() {
    let dir = tempfile::tempdir().unwrap();
    let mut selected = node_fixture(dir.path());
    selected.server = Some(Server {
        bin: dir.path().join("existing/cli.js"),
        managed: false,
        node_entry: None,
    });
    let old_node = selected.node.clone();
    let token = CancelToken::default();
    repair_node(&mut selected, dir.path(), OsStr::new(""), "22", &token, || {
        panic!("healthy node must not reinstall")
    })
    .unwrap();
    repair_git(&mut selected, &token, || Ok(git_fixture(dir.path()))).unwrap();
    repair_git(&mut selected, &token, || panic!("healthy Git must not reinstall")).unwrap();
    assert_eq!(selected.node, old_node);
    assert!(selected.npm_cli.is_some());
    assert_eq!(selected.server.unwrap().bin, dir.path().join("existing/cli.js"));
    assert!(selected.git.is_some());
}

#[test]
fn missing_saved_tools_repair_to_new_private_paths_without_external_writes() {
    let dir = tempfile::tempdir().unwrap();
    let mut selected = Selection::new(
        dir.path().join("external/node.exe"),
        dir.path().join("external/npm.cmd"),
        dir.path().join("keep-prefix"),
    );
    selected.server = Some(Server {
        bin: dir.path().join("keep-cli.js"),
        managed: true,
        node_entry: None,
    });
    let token = CancelToken::default();
    repair_node(&mut selected, dir.path(), OsStr::new(""), "22", &token, || {
        let mut new = node_fixture(&dir.path().join("new-private"));
        new.node_managed = true;
        Ok(new)
    })
    .unwrap();
    assert!(selected.node.starts_with(dir.path().join("new-private")));
    assert!(!dir.path().join("external").exists());
    assert_eq!(selected.prefix, dir.path().join("keep-prefix"));
    assert_eq!(selected.server.unwrap().bin, dir.path().join("keep-cli.js"));
    assert!(selected.node_managed);
}

#[test]
fn attempt_cancel_cleans_only_new_stage() {
    let _lock = super::super::CANCEL_TEST.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("runtime/good")).unwrap();
    let stage = new_attempt(dir.path(), "test").unwrap();
    let stage_path = stage.path().to_owned();
    let guard = super::super::InstallGuard::begin().unwrap();
    super::super::cancel_install();
    assert_eq!(promote(stage, guard.token()), Err("SETUP_CANCELLED".into()));
    assert!(!stage_path.exists());
    assert!(dir.path().join("runtime/good").is_dir());
}

fn script(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn node_fixture(root: &Path) -> Selection {
    let selected = Selection::new(
        root.join("node/node.exe"),
        root.join("node/npm.cmd"),
        root.join("prefix"),
    );
    super::super::selection_windows_tests::npm_layout(&selected);
    script(&selected.node, "echo v24.21.0");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&selected.npm, std::fs::Permissions::from_mode(0o755)).unwrap();
    selected
}

fn git_fixture(root: &Path) -> GitSelection {
    let path = root.join("Git");
    for file in [
        "cmd/git.exe",
        "usr/bin/bash.exe",
        "usr/bin/sh.exe",
        "usr/bin/grep.exe",
    ] {
        script(&path.join(file), "echo fixture");
    }
    script(&path.join("cmd/git.exe"), "echo 'git version 2.56.0.windows.2'");
    script(&path.join("usr/bin/bash.exe"), "echo cortex-git-qualified");
    GitSelection::from_root(path, true).unwrap()
}
