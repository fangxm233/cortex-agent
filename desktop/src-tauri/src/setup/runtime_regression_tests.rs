//! Audit regressions: all executables and selections live under temporary directories.
use super::*;
use std::{
    process::Command,
    time::{Duration, Instant},
};

fn bootstrap_default(home: &Path, path: &OsStr) -> Result<Selection, String> {
    bootstrap(home, path, "22.19.0", &CancelToken::default(), &|_| {})
}

fn split_fixture(root: &Path) -> std::path::PathBuf {
    let home = root.join("home");
    let node = root.join("node-bin/node");
    let npm = root.join("npm-bin/npm");
    script(&node, "echo v24.21.0");
    script(&npm, "echo 11.0.0");
    script(&node.with_file_name("npm"), "echo 99.0.0");
    let path = std::env::join_paths([npm.parent().unwrap(), node.parent().unwrap()]).unwrap();
    assert_eq!(bootstrap_default(&home, &path).unwrap().npm, npm);
    home
}

#[test]
fn split_runtime_pins_both_tools_despite_competing_npm_and_changed_login_path() {
    let root = tempfile::tempdir().unwrap();
    let home = split_fixture(root.path());
    let saved = std::fs::read(home.join("runtime/selection.json")).unwrap();
    let login = root.path().join("new-login");
    script(&login.join("node"), "echo v99.0.0");
    script(&login.join("npm"), "echo 88.0.0");
    let next = bootstrap_default(&home, login.as_os_str()).unwrap();
    let output = selected_output(
        &next,
        &home,
        login.as_os_str(),
        OsStr::new("/bin/sh"),
        &["-c", "node --version; npm --version"],
    )
    .unwrap();
    assert_eq!(output, "v24.21.0\n11.0.0");
    assert_eq!(
        std::fs::read(home.join("runtime/selection.json")).unwrap(),
        saved
    );
}

fn saved_fixture(root: &Path) -> (std::path::PathBuf, std::ffi::OsString, Selection) {
    let path = fixture_runtime(root);
    let home = root.join("home");
    let selected = bootstrap_default(&home, &path).unwrap();
    (home, path, selected)
}

fn damage_runtime(bin: &Path, failure: &str) {
    use std::os::unix::fs::PermissionsExt;
    match failure {
        "executable" => {
            std::fs::set_permissions(bin, std::fs::Permissions::from_mode(0o644)).unwrap()
        }
        "version" => script(bin, "echo v0.0.1"),
        _ => script(bin, "exit 1"),
    }
}

fn assert_saved_rejected(tool: &str, failure: &str) {
    let root = tempfile::tempdir().unwrap();
    let (home, _, selected) = saved_fixture(root.path());
    let bin = if tool == "node" {
        &selected.node
    } else {
        &selected.npm
    };
    let saved = std::fs::read(home.join("runtime/selection.json")).unwrap();
    damage_runtime(bin, failure);
    let healthy_fallback = fixture_runtime(&root.path().join("fallback"));
    let error = bootstrap_default(&home, &healthy_fallback).unwrap_err();
    assert!(
        error.starts_with("RUNTIME_MISSING"),
        "{tool}/{failure}: {error}"
    );
    assert_eq!(
        std::fs::read(home.join("runtime/selection.json")).unwrap(),
        saved
    );
}

#[test]
fn saved_runtime_executable_or_version_loss_is_missing_without_fallback() {
    for tool in ["node", "npm"] {
        for failure in ["executable", "version", "cannot-run"] {
            assert_saved_rejected(tool, failure);
        }
    }
}

#[test]
fn cancelled_saved_runtime_cannot_return_success() {
    let _serial = CANCEL_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let root = tempfile::tempdir().unwrap();
    let (home, path, _) = saved_fixture(root.path());
    let owner = InstallGuard::begin().unwrap();
    cancel_install();
    assert_eq!(
        bootstrap(&home, &path, "22.19.0", owner.token(), &|_| {}).unwrap_err(),
        "SETUP_CANCELLED"
    );
}

struct Unrelated(std::process::Child);
impl Drop for Unrelated {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn cancel_at_marker(marker: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        assert!(
            Instant::now() < deadline,
            "probe never started: {}",
            marker.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    cancel_install();
}

fn cancelled_install(home: &Path, path: &OsStr) -> (Result<Selection, String>, Duration) {
    let owner = InstallGuard::begin().unwrap();
    let marker = home.join("probe-started");
    let mut unrelated = Unrelated(Command::new("/bin/sleep").arg("30").spawn().unwrap());
    let start = Instant::now();
    let result = std::thread::scope(|scope| {
        scope.spawn(|| cancel_at_marker(&marker));
        ensure_server(
            home,
            path,
            || Ok("fixture.tgz".into()),
            "22.19.0",
            "2026.8.20",
            owner.token(),
            &|_| {},
        )
    });
    let elapsed = start.elapsed();
    assert!(
        unrelated.0.try_wait().unwrap().is_none(),
        "unrelated process was killed"
    );
    (result, elapsed)
}

fn stall_script() -> &'static str {
    "echo started > \"$CORTEX_HOME/probe-started\"; /bin/sleep 2 & wait"
}

fn prepare_probe(root: &Path, probe: &str) -> (std::path::PathBuf, std::ffi::OsString) {
    let path = fixture_runtime(root);
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let bin = root.join("external/bin");
    let cases = [
        ("node", "node", "STALL; echo v24.21.0"),
        ("npm", "npm", "STALL; echo 11.0.0"),
        (
            "prefix",
            "npm",
            "if [ \"$1\" = --version ]; then echo 11.0.0; else STALL; echo /nonexistent; fi",
        ),
        ("server", "cortex", "STALL; echo 2026.10.6"),
        (
            "server-fallback",
            "cortex",
            "if [ \"$1\" = --version ]; then exit 1; else STALL; echo 2026.10.6; fi",
        ),
    ];
    let (_, tool, contents) = cases.iter().find(|(name, _, _)| *name == probe).unwrap();
    script(&bin.join(tool), &contents.replace("STALL", stall_script()));
    (home, path)
}

#[test]
fn stalled_install_probes_cancel_promptly_without_killing_unrelated_process() {
    let _serial = CANCEL_TEST.lock().unwrap_or_else(|e| e.into_inner());
    for probe in ["node", "npm", "prefix", "server", "server-fallback"] {
        let root = tempfile::tempdir().unwrap();
        let (home, path) = prepare_probe(root.path(), probe);
        let (result, elapsed) = cancelled_install(&home, &path);
        assert_eq!(result.unwrap_err(), "SETUP_CANCELLED", "{probe}");
        assert!(elapsed < Duration::from_secs(1), "{probe}: {elapsed:?}");
    }
}

#[test]
fn stalled_saved_runtime_and_server_validation_cancel_without_reselection() {
    let _serial = CANCEL_TEST.lock().unwrap_or_else(|e| e.into_inner());
    for tool in ["node", "npm", "cortex"] {
        let root = tempfile::tempdir().unwrap();
        let (home, path, mut selected) = saved_fixture(root.path());
        let bin = root.path().join("external/bin").join(tool);
        let server = root.path().join("external/bin/cortex");
        script(&server, "echo 2026.10.6");
        selected.server = Some(Server {
            bin: server,
            managed: false,
            node_entry: None,
        });
        selected.save(&home).unwrap();
        let saved = std::fs::read(home.join("runtime/selection.json")).unwrap();
        script(&bin, &format!("{}; echo 2026.10.6", stall_script()));
        let (result, elapsed) = cancelled_install(&home, &path);
        assert_eq!(result.unwrap_err(), "SETUP_CANCELLED", "{tool}");
        assert!(elapsed < Duration::from_secs(1), "{tool}: {elapsed:?}");
        assert_eq!(
            std::fs::read(home.join("runtime/selection.json")).unwrap(),
            saved
        );
    }
}

#[test]
fn cancellation_after_discovery_prevents_initial_selection_save() {
    let _serial = CANCEL_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let root = tempfile::tempdir().unwrap();
    let path = fixture_runtime(root.path());
    let home = root.path().join("home");
    let owner = InstallGuard::begin().unwrap();
    let result = bootstrap(&home, &path, "22.19.0", owner.token(), &|_| {
        cancel_install()
    });
    assert_eq!(result.unwrap_err(), "SETUP_CANCELLED");
    assert!(Selection::load(&home).unwrap().is_none());
}

#[test]
fn cancelled_final_managed_validation_never_persists_server_success() {
    let _serial = CANCEL_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let root = tempfile::tempdir().unwrap();
    let (home, path, selected) = saved_fixture(root.path());
    let npm = std::fs::read_to_string(&selected.npm).unwrap();
    let slow_cli =
        "echo started > \"$CORTEX_HOME/probe-started\"; /bin/sleep 2 & wait; echo 2026.10.6";
    std::fs::write(&selected.npm, npm.replace("echo 2026.10.6", slow_cli)).unwrap();
    let (result, elapsed) = cancelled_install(&home, &path);
    assert!(
        Selection::load(&home).unwrap().unwrap().server.is_none(),
        "cancelled validation saved a server"
    );
    assert_eq!(result.unwrap_err(), "SETUP_CANCELLED");
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
}
