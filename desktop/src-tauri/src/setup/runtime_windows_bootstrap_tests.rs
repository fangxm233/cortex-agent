use super::super::Server;
use super::*;

#[test]
fn repair_preserves_good_node_and_server_and_adds_missing_git() {
    let dir = tempfile::tempdir().unwrap();
    let mut selected = node_fixture(dir.path());
    selected.server = Some(server_fixture(dir.path().join("existing/cli.js"), false));
    let old_node = selected.node.clone();
    let token = CancelToken::default();
    repair_node(
        &mut selected,
        dir.path(),
        OsStr::new(""),
        "22",
        &token,
        || panic!("healthy node must not reinstall"),
    )
    .unwrap();
    repair_git(&mut selected, &token, || Ok(git_fixture(dir.path()))).unwrap();
    repair_git(&mut selected, &token, || {
        panic!("healthy Git must not reinstall")
    })
    .unwrap();
    assert_eq!(selected.node, old_node);
    assert!(selected.npm_cli.is_some());
    assert_eq!(
        selected.server.unwrap().bin,
        dir.path().join("existing/cli.js")
    );
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
    selected.server = Some(server_fixture(dir.path().join("keep-cli.js"), true));
    let token = CancelToken::default();
    repair_node(
        &mut selected,
        dir.path(),
        OsStr::new(""),
        "22",
        &token,
        || {
            let mut new = node_fixture(&dir.path().join("new-private"));
            new.node_managed = true;
            Ok(new)
        },
    )
    .unwrap();
    assert!(selected.node.starts_with(dir.path().join("new-private")));
    assert!(!dir.path().join("external").exists());
    assert_eq!(selected.prefix, dir.path().join("keep-prefix"));
    assert_eq!(selected.server.unwrap().bin, dir.path().join("keep-cli.js"));
    assert!(selected.node_managed);
}

#[test]
fn attempt_guard_owns_only_new_stage_until_publication() {
    let dir = tempfile::tempdir().unwrap();
    let old = old_selection(dir.path());
    let mut attempts = Vec::new();
    let stage = new_attempt(dir.path(), "test", &mut attempts).unwrap();
    assert!(stage.is_dir());
    drop(attempts);
    assert!(!stage.exists());
    assert_old_saved(dir.path(), &old);
}

#[test]
fn node_success_then_git_failure_cleans_both_new_attempts() {
    node_then_git_error(false);
}

#[test]
fn node_success_then_git_cancel_cleans_both_new_attempts() {
    node_then_git_error(true);
}

fn node_then_git_error(cancel: bool) {
    let _lock = super::super::CANCEL_TEST.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let old = old_selection(dir.path());
    let guard = super::super::InstallGuard::begin().unwrap();
    let mut paths = Vec::new();
    let result = (|| {
        let mut attempts = Vec::new();
        let mut selected = prepared_node(dir.path(), &mut attempts);
        repair_git(&mut selected, guard.token(), || {
            let stage = new_attempt(dir.path(), "git-test", &mut attempts)?;
            let git = git_fixture(&stage);
            paths = attempt_paths(&attempts);
            if cancel {
                super::super::cancel_install();
                return Ok(git);
            }
            Err("Git preparation failed".into())
        })
    })();
    let expected = if cancel {
        "SETUP_CANCELLED"
    } else {
        "Git preparation failed"
    };
    assert_eq!(result, Err(expected.into()));
    assert_eq!(paths.len(), 2);
    assert!(paths.iter().all(|path| !path.exists()));
    assert_old_saved(dir.path(), &old);
}

#[test]
fn selection_save_failure_cleans_new_tools_preserving_old_saved_tools() {
    let dir = tempfile::tempdir().unwrap();
    let old = old_selection(dir.path());
    let mut attempts = Vec::new();
    let selected = prepared_tools(dir.path(), &mut attempts);
    let paths = attempt_paths(&attempts);
    let blocked = dir.path().join("blocked");
    std::fs::create_dir_all(blocked.join("runtime/selection.json")).unwrap();
    let result = publish(selected, attempts, &CancelToken::default(), |selected| {
        assert!(paths.iter().all(|path| path.is_dir()));
        selected.save(&blocked)
    });
    assert!(result.unwrap_err().starts_with("SERVER_INSTALL_FAILED:"));
    assert!(paths.iter().all(|path| !path.exists()));
    assert_old_saved(dir.path(), &old);
}

#[test]
fn cancellation_before_save_cleans_new_tools_without_publication() {
    let _lock = super::super::CANCEL_TEST.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let old = old_selection(dir.path());
    let mut attempts = Vec::new();
    let selected = prepared_tools(dir.path(), &mut attempts);
    let paths = attempt_paths(&attempts);
    let guard = super::super::InstallGuard::begin().unwrap();
    super::super::cancel_install();
    let result = publish(selected, attempts, guard.token(), |_| {
        panic!("must not save")
    });
    assert_eq!(result.unwrap_err(), "SETUP_CANCELLED");
    assert!(paths.iter().all(|path| !path.exists()));
    assert_old_saved(dir.path(), &old);
}

#[test]
fn validation_failure_cleans_new_tools_without_publication() {
    let dir = tempfile::tempdir().unwrap();
    let old = old_selection(dir.path());
    let mut attempts = Vec::new();
    let mut selected = prepared_tools(dir.path(), &mut attempts);
    let paths = attempt_paths(&attempts);
    selected.node = dir.path().join("missing");
    let result = publish(selected, attempts, &CancelToken::default(), |_| {
        panic!("must not save")
    });
    assert!(result.unwrap_err().starts_with("RUNTIME_MISSING:"));
    assert!(paths.iter().all(|path| !path.exists()));
    assert_old_saved(dir.path(), &old);
}

#[test]
fn publication_keeps_exact_qualified_node_and_git_paths() {
    let dir = tempfile::tempdir().unwrap();
    let mut attempts = Vec::new();
    let selected = prepared_tools(dir.path(), &mut attempts);
    let identities = serde_json::to_value(&selected).unwrap();
    let paths = attempt_paths(&attempts);
    let result = publish(selected, attempts, &CancelToken::default(), |selected| {
        assert!(paths.iter().all(|path| path.is_dir()));
        selected.save(dir.path())
    })
    .unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), identities);
    let saved = Selection::load(dir.path()).unwrap().unwrap();
    assert_eq!(serde_json::to_value(saved).unwrap(), identities);
    assert!(paths.iter().all(|path| path.is_dir()));
}

#[test]
fn cancellation_during_successful_save_never_removes_published_tools() {
    let _lock = super::super::CANCEL_TEST.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut attempts = Vec::new();
    let selected = prepared_tools(dir.path(), &mut attempts);
    let identities = serde_json::to_value(&selected).unwrap();
    let paths = attempt_paths(&attempts);
    let guard = super::super::InstallGuard::begin().unwrap();
    let result = publish(selected, attempts, guard.token(), |selected| {
        selected.save(dir.path())?;
        super::super::cancel_install();
        Ok(())
    });
    assert_eq!(result.unwrap_err(), "SETUP_CANCELLED");
    let saved = Selection::load(dir.path()).unwrap().unwrap();
    assert_eq!(serde_json::to_value(saved).unwrap(), identities);
    assert!(paths.iter().all(|path| path.is_dir()));
}

fn attempt_paths(attempts: &[tempfile::TempDir]) -> Vec<PathBuf> {
    attempts
        .iter()
        .map(|attempt| attempt.path().to_owned())
        .collect()
}

fn old_selection(home: &Path) -> Selection {
    let mut selected = node_fixture(&home.join("external"));
    selected.git = Some(git_fixture(&home.join("runtime/old-managed")));
    selected.save(home).unwrap();
    selected
}

fn assert_old_saved(home: &Path, old: &Selection) {
    let saved = Selection::load(home).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(saved).unwrap(),
        serde_json::to_value(old).unwrap()
    );
    assert!(old.node.is_file());
    old.git.as_ref().unwrap().validate().unwrap();
}

fn prepared_node(home: &Path, attempts: &mut Vec<tempfile::TempDir>) -> Selection {
    let mut selected = Selection::new(
        home.join("missing-node"),
        home.join("missing-npm"),
        home.join("prefix"),
    );
    let token = CancelToken::default();
    repair_node(&mut selected, home, OsStr::new(""), "22", &token, || {
        let stage = new_attempt(home, "node-test", attempts)?;
        let mut node = node_fixture(&stage);
        node.node_managed = true;
        assert!(node.qualify_windows_npm());
        assert!(node.qualify_node(home, OsStr::new(""), "22", &token)?);
        Ok(node)
    })
    .unwrap();
    selected
}

fn prepared_tools(home: &Path, attempts: &mut Vec<tempfile::TempDir>) -> Selection {
    let mut selected = prepared_node(home, attempts);
    let token = CancelToken::default();
    repair_git(&mut selected, &token, || {
        let stage = new_attempt(home, "git-test", attempts)?;
        let git = git_fixture(&stage);
        assert!(git.qualify(&token)?);
        Ok(git)
    })
    .unwrap();
    selected
}

fn server_fixture(bin: PathBuf, managed: bool) -> Server {
    Server {
        bin,
        managed,
        node_entry: None,
    }
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
    script(
        &path.join("cmd/git.exe"),
        "echo 'git version 2.56.0.windows.2'",
    );
    script(&path.join("usr/bin/bash.exe"), "echo cortex-git-qualified");
    GitSelection::from_root(path, true).unwrap()
}
