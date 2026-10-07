// Headless tests compile the production runtime implementation without Tauri/GTK.
#![cfg(test)]
#[path = "runtime.rs"]
#[allow(dead_code)]
mod runtime;

use runtime::*;
use std::ffi::OsStr;
use std::path::Path;
static CANCEL_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn script(path: &Path, contents: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{contents}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn fixture_runtime(root: &Path) -> std::ffi::OsString {
    let bin = root.join("external/bin");
    script(
        &bin.join("node"),
        "if [ \"$1\" = --version ]; then echo v24.21.0; else exec /bin/sh \"$@\"; fi",
    );
    script(
        &bin.join("npm"),
        r#"
case "$1" in
 --version) echo 11.0.0 ;;
 prefix) echo /nonexistent-external-prefix ;;
 install)
   test "$3" = --prefix || exit 33
   test "$4" = "$NPM_CONFIG_PREFIX" || exit 34
   /bin/mkdir -p "$4/bin" "$4/lib/node_modules/fixture"
   printf '#!/bin/sh\necho 2026.10.6\n' > "$4/lib/node_modules/fixture/cli.js"
   /bin/ln -sf ../lib/node_modules/fixture/cli.js "$4/bin/cortex"
   echo installed >> "$CORTEX_HOME/install-count"
   ;;
 *) exit 42 ;;
esac
"#,
    );
    bin.into_os_string()
}

fn install_fixture(home: &Path, path: &OsStr) -> Result<Selection, String> {
    ensure_server(
        home,
        path,
        OsStr::new("fixture.tgz"),
        "22.19.0",
        "2026.8.20",
        &CancelToken::default(),
        &|_| {},
    )
}

#[test]
fn private_install_is_direct_persisted_and_idempotent_without_external_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let path = fixture_runtime(root.path());
    let home = root.path().join("home with spaces");
    let first = install_fixture(&home, &path).unwrap();
    let server = first.server.as_ref().unwrap();
    assert!(server.managed);
    assert_eq!(
        server.bin,
        home.join("runtime/prefix/lib/node_modules/fixture/cli.js")
    );
    assert_eq!(
        first.command(server.bin.as_os_str()).get_program(),
        first.node
    );
    let second = install_fixture(&home, OsStr::new("/other-login/bin")).unwrap();
    assert_eq!(second.node, first.node);
    assert_eq!(
        std::fs::read_to_string(home.join("install-count")).unwrap(),
        "installed\n"
    );
}

#[test]
fn qualified_external_server_is_reused_but_old_server_is_not_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let path = fixture_runtime(root.path());
    let bin = root.path().join("external/bin/cortex");
    script(&bin, "echo 2026.10.6");
    let home = root.path().join("supported");
    let saved = install_fixture(&home, &path).unwrap();
    assert!(!saved.server.as_ref().unwrap().managed);
    assert_eq!(saved.command(bin.as_os_str()).get_program(), bin);
    assert!(!home.join("install-count").exists());
    script(&bin, "echo 2025.1.1");
    let old = root.path().join("old");
    assert!(install_fixture(&old, &path)
        .unwrap_err()
        .starts_with("SERVER_EXTERNAL_UNSUPPORTED"));
    assert!(!old.join("install-count").exists());
}

#[test]
fn npm_cancellation_kills_only_the_owned_process_group() {
    let _serial = CANCEL_TEST.lock().unwrap();
    let owner = InstallGuard::begin().unwrap();
    let mut command = std::process::Command::new("/bin/sh");
    command.args(["-c", "sleep 30 & wait"]);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(150));
            cancel_install();
        });
        assert_eq!(
            run_install(command, owner.token(), &|_| {}).unwrap_err(),
            "SETUP_CANCELLED"
        );
    });
}

#[test]
fn credentials_never_reach_install_events() {
    for line in [
        "npm https://user:password@registry.example/file",
        "token=fixture",
        "Authorization: Bearer fixture",
        "api_key=fixture",
    ] {
        assert!(!redact_line(line).contains("fixture"));
        assert!(redact_line(line).contains("redacted"));
    }
    assert_eq!(
        redact_line("npm ERR! network unavailable"),
        "npm ERR! network unavailable"
    );
}

/// Deliberately opt-in: parent runs real bootstrap + npm install against an isolated thin tgz.
/// HOME is not changed; CORTEX_HOME and npm prefix are child-local. No init/daemon/service is started.
#[test]
#[ignore = "downloads official Node and installs the explicitly supplied server tgz"]
fn isolated_real_bootstrap_and_install() {
    let home = std::path::PathBuf::from(
        std::env::var_os("CORTEX_RUNTIME_TEST_HOME").expect("set a NEW absolute isolated home"),
    );
    let package = std::path::PathBuf::from(
        std::env::var_os("CORTEX_RUNTIME_TEST_PACKAGE").expect("set an absolute thin server tgz"),
    );
    assert!(
        home.is_absolute() && !home.exists(),
        "test home must not exist"
    );
    assert!(package.is_absolute() && package.is_file());
    let owner = InstallGuard::begin().unwrap();
    let log = |line: &str| eprintln!("{}", redact_line(line));
    bootstrap(
        &home,
        OsStr::new("/nonexistent"),
        "22.19.0",
        owner.token(),
        &log,
    )
    .unwrap();
    let selected = ensure_server(
        &home,
        OsStr::new("/usr/bin:/bin"),
        package.as_os_str(),
        "22.19.0",
        "2026.8.20",
        owner.token(),
        &log,
    )
    .unwrap();
    assert!(selected.server.as_ref().unwrap().managed);
    eprintln!(
        "Isolated selection: {}",
        home.join("runtime/selection.json").display()
    );
    let reloaded = install_fixture(&home, OsStr::new("/nonexistent")).unwrap();
    assert_eq!(selected.node, reloaded.node);
}

#[test]
fn release_targets_are_pinned_and_unsupported_targets_refuse() {
    for (os, arch) in [
        ("macos", "x86_64"),
        ("macos", "aarch64"),
        ("linux", "x86_64"),
        ("linux", "aarch64"),
    ] {
        let release = release_for(os, arch).unwrap();
        assert!(release.archive.contains("v24.21.0"));
        assert_eq!(release.sha256.len(), 64);
    }
    assert!(release_for("windows", "x86_64")
        .unwrap_err()
        .starts_with("RUNTIME_UNSUPPORTED"));
    assert!(release_for("linux", "riscv64").is_err());
}

#[test]
fn archive_paths_and_relative_npm_links_stay_inside_root() {
    assert!(safe_member(Path::new("node/bin/npm"), "node").is_ok());
    for name in ["/node/bin/node", "node/../escape", "other/bin/node"] {
        assert!(safe_member(Path::new(name), "node").is_err(), "{name}");
    }
    assert!(safe_link(
        Path::new("bin/npm"),
        Path::new("../lib/node_modules/npm/bin/npm-cli.js")
    )
    .is_ok());
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
    assert!(Selection::load(home)
        .unwrap_err()
        .starts_with("RUNTIME_MISSING"));
}

#[test]
fn selected_node_and_private_prefix_precede_changing_login_path() {
    let selection = Selection::new(
        "/chosen/bin/node".into(),
        "/chosen/bin/npm".into(),
        "/private/prefix".into(),
    );
    let path = selection
        .path(std::ffi::OsStr::new("/other/bin:/usr/bin"))
        .unwrap();
    let parts: Vec<_> = std::env::split_paths(&path).collect();
    assert_eq!(parts[0], Path::new("/chosen/bin"));
    assert_eq!(parts[1], Path::new("/private/prefix/bin"));
}

#[test]
fn cancellation_is_owned_and_does_not_poison_next_install() {
    let _serial = CANCEL_TEST.lock().unwrap();
    let owner = InstallGuard::begin().unwrap();
    assert!(InstallGuard::begin().is_err());
    cancel_install();
    assert_eq!(owner.token().check().unwrap_err(), "SETUP_CANCELLED");
    drop(owner);
    cancel_install();
    assert!(InstallGuard::begin().unwrap().token().check().is_ok());
}
