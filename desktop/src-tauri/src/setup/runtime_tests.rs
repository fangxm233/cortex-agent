// Headless tests compile the production runtime implementation without Tauri/GTK.
#![cfg(test)]
#[path = "runtime.rs"]
#[allow(dead_code)]
mod runtime;
#[path = "runtime_regression_tests.rs"]
mod runtime_regression_tests;
#[path = "runtime_selection_tests.rs"]
mod runtime_selection_tests;

use runtime::CANCEL_TEST;
use runtime::*;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

const ROOT: &str = "node-v24.21.0-fixture";
const PATH: &str = "/usr/bin:/bin";

fn script(path: &Path, contents: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{contents}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// npm stand-in: `node npm-cli.js install -g --prefix <prefix> <pkg>` writes a server printing `version`.
fn npm_script(version: &str) -> String {
    format!(
        r#"case "$1" in
 --version) echo 11.0.0 ;;
 install)
   test "$3" = --prefix || exit 33
   test "$4" = "$NPM_CONFIG_PREFIX" || exit 34
   mkdir -p "$4/bin" "$4/lib/node_modules/fixture"
   printf '#!/bin/sh\necho {version}\n' > "$4/lib/node_modules/fixture/cli.js"
   ln -sf ../lib/node_modules/fixture/cli.js "$4/bin/cortex"
   echo installed >> "$CORTEX_HOME/install-count"
   ;;
 *) exit 42 ;;
esac"#
    )
}

/// A bundle directory like `<resources>/runtime`: manifest.json + an official-layout Node archive.
/// The fixture `node` runs its script argument with /bin/sh, so npm-cli.js is a shell script.
fn bundle_with(root: &Path, node: &str, npm: &str) -> PathBuf {
    let tree = root.join("bundle-src").join(ROOT);
    script(&tree.join("bin/node"), node);
    script(&tree.join("lib/node_modules/npm/bin/npm-cli.js"), npm);
    std::os::unix::fs::symlink("../lib/node_modules/npm/bin/npm-cli.js", tree.join("bin/npm")).unwrap();
    let bundle = root.join("bundle");
    std::fs::create_dir_all(&bundle).unwrap();
    let file = std::fs::File::create(bundle.join("node.tar.gz")).unwrap();
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::fast()));
    builder.follow_symlinks(false);
    builder.append_dir_all(ROOT, &tree).unwrap();
    builder.into_inner().unwrap().finish().unwrap();
    std::fs::write(
        bundle.join("manifest.json"),
        format!(r#"{{"node":{{"version":"24.21.0","archive":"node.tar.gz","root":"{ROOT}"}}}}"#),
    )
    .unwrap();
    bundle
}

const NODE: &str = r#"if [ "$1" = --version ]; then echo v24.21.0; else exec /bin/sh "$@"; fi"#;

fn bundle(root: &Path) -> PathBuf {
    bundle_with(root, NODE, &npm_script("2026.10.6"))
}

fn install(home: &Path, bundle: &Path) -> Result<Selection, String> {
    ensure_server(
        home,
        bundle,
        OsStr::new(PATH),
        || Ok("fixture.tgz".into()),
        "2026.8.20",
        &CancelToken::default(),
        &|_| {},
    )
}

fn installs(home: &Path) -> usize {
    std::fs::read_to_string(home.join("install-count")).map_or(0, |s| s.lines().count())
}

fn bundled_node(home: &Path) -> PathBuf {
    home.join("runtime").join(ROOT).join("bin/node")
}

#[test]
fn fresh_install_uses_the_bundled_node_and_a_private_prefix_once() {
    let root = tempfile::tempdir().unwrap();
    let bundle = bundle(root.path());
    let home = root.path().join("home with spaces");
    let first = install(&home, &bundle).unwrap();
    assert_eq!(first.node, bundled_node(&home));
    assert_eq!(first.npm_cli.as_deref(), Some(&*home.join("runtime").join(ROOT).join("lib/node_modules/npm/bin/npm-cli.js")));
    let server = first.server.as_ref().unwrap();
    assert!(server.managed);
    assert_eq!(server.bin, home.join("runtime/prefix/lib/node_modules/fixture/cli.js"));
    assert_eq!(first.command(server.bin.as_os_str()).get_program(), first.node);
    let second = ensure_server(
        &home,
        &bundle,
        OsStr::new("/other-login/bin"),
        || panic!("a working saved server needs no package"),
        "2026.8.20",
        &CancelToken::default(),
        &|_| {},
    )
    .unwrap();
    assert_eq!(second, first);
    assert_eq!(Selection::load(&home).unwrap().unwrap(), first);
    assert_eq!(installs(&home), 1);
}

#[test]
fn a_cortex_already_on_path_is_not_adopted() {
    let root = tempfile::tempdir().unwrap();
    let bundle = bundle(root.path());
    let external = root.path().join("external/bin");
    script(&external.join("cortex"), "echo 2026.10.6");
    script(&external.join("node"), "echo v24.0.0");
    let home = root.path().join("home");
    let path = std::env::join_paths([external.as_path(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap();
    let selected = ensure_server(
        &home,
        &bundle,
        &path,
        || Ok("fixture.tgz".into()),
        "2026.8.20",
        &CancelToken::default(),
        &|_| {},
    )
    .unwrap();
    assert!(selected.server.unwrap().managed);
    assert_eq!(selected.node, bundled_node(&home));
    assert_eq!(installs(&home), 1);
}

fn old_record(home: &Path, node: &Path, server: Option<Server>) {
    let mut old = Selection::new(node.to_path_buf(), node.with_file_name("npm"), home.join("runtime/prefix"));
    old.server = server;
    std::fs::create_dir_all(home.join("runtime")).unwrap();
    std::fs::write(home.join("runtime/selection.json"), serde_json::to_vec(&old).unwrap()).unwrap();
}

#[test]
fn a_record_using_an_external_node_moves_to_the_bundled_node_and_keeps_its_server() {
    for external_exists in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let bundle = bundle(root.path());
        let home = root.path().join("home");
        let node = root.path().join("nvm/bin/node");
        if external_exists {
            script(&node, "echo v22.19.0");
            script(&node.with_file_name("npm"), "echo 10.0.0");
        }
        let prefix = home.join("runtime/prefix");
        script(&prefix.join("lib/node_modules/fixture/cli.js"), "echo 2026.10.6");
        let server = Server { bin: prefix.join("lib/node_modules/fixture/cli.js"), managed: true, node_entry: None };
        old_record(&home, &node, Some(server.clone()));
        if !external_exists {
            assert!(Selection::load(&home).is_err(), "the old record is a dead end without migration");
        }
        let selected = install(&home, &bundle).unwrap();
        assert_eq!(selected.node, bundled_node(&home));
        assert_eq!(selected.server, Some(server));
        assert_eq!(Selection::load(&home).unwrap().unwrap(), selected);
        assert_eq!(installs(&home), 0, "the saved server still works");
    }
}

#[test]
fn a_removed_runtime_directory_is_restored_without_touching_the_server() {
    let root = tempfile::tempdir().unwrap();
    let bundle = bundle(root.path());
    let home = root.path().join("home");
    let installed = install(&home, &bundle).unwrap();
    std::fs::remove_dir_all(home.join("runtime").join(ROOT)).unwrap();
    assert!(Selection::load(&home).is_err());
    let restored = ensure_runtime(&home, &bundle, &CancelToken::default(), &|_| {}).unwrap();
    assert_eq!(restored, installed);
    assert!(bundled_node(&home).is_file());
    assert_eq!(installs(&home), 1);
}

#[test]
fn a_saved_server_that_fails_is_reinstalled_privately_once() {
    let root = tempfile::tempdir().unwrap();
    let bundle = bundle(root.path());
    let home = root.path().join("home");
    let external = root.path().join("external/bin/cortex");
    script(&external, "echo 2025.1.1");
    old_record(&home, &root.path().join("gone/node"), Some(Server { bin: external.clone(), managed: false, node_entry: None }));
    let selected = install(&home, &bundle).unwrap();
    let server = selected.server.unwrap();
    assert!(server.managed);
    assert_ne!(server.bin, external);
    assert_eq!(installs(&home), 1);
    assert_eq!(std::fs::read_to_string(&external).unwrap(), "#!/bin/sh\necho 2025.1.1\n", "external install untouched");
}

#[test]
fn a_private_install_that_is_still_too_old_reports_it() {
    let root = tempfile::tempdir().unwrap();
    let bundle = bundle_with(root.path(), NODE, &npm_script("2025.1.1"));
    let home = root.path().join("home");
    assert!(install(&home, &bundle).unwrap_err().starts_with("SERVER_TOO_OLD"));
    assert!(Selection::load(&home).unwrap().unwrap().server.is_none());
    assert_eq!(installs(&home), 1);
}

#[test]
fn a_build_without_its_runtime_says_so() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let error = install(&home, &root.path().join("no-bundle")).unwrap_err();
    assert_eq!(error, NOT_BUNDLED);
    assert!(!home.join("runtime/selection.json").exists());
}

#[test]
fn a_failed_npm_install_can_be_retried() {
    let root = tempfile::tempdir().unwrap();
    let bundle = bundle_with(root.path(), NODE, "exit 17");
    let home = root.path().join("home");
    assert!(install(&home, &bundle).unwrap_err().starts_with("SERVER_INSTALL_FAILED"));
    let before = Selection::load(&home).unwrap().unwrap();
    assert!(before.server.is_none());
    let cli = home.join("runtime").join(ROOT).join("lib/node_modules/npm/bin/npm-cli.js");
    script(&cli, &npm_script("2026.10.6"));
    let after = install(&home, &bundle).unwrap();
    assert_eq!(before.node, after.node);
    assert!(after.server.unwrap().managed);
}

#[test]
fn npm_cancellation_kills_only_the_owned_process_group() {
    let _serial = CANCEL_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let owner = InstallGuard::begin().unwrap();
    let mut unrelated = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let mut command = std::process::Command::new("/bin/sh");
    command.args(["-c", "sleep 30 & wait"]);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(150));
            cancel_install();
        });
        assert_eq!(run_install(command, owner.token(), &|_| {}).unwrap_err(), "SETUP_CANCELLED");
    });
    assert!(unrelated.try_wait().unwrap().is_none());
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
}

#[test]
fn credentials_never_reach_install_events() {
    for line in [
        "npm https://user:password@registry.example/file",
        "token=fixture",
        "Authorization: Bearer fixture",
        "api_key=fixture",
        "npm ERR! _auth=fixture",
        "https://registry.example/package?X-Amz-Signature=fixture",
    ] {
        assert!(!redact_line(line).contains("fixture"));
        assert!(redact_line(line).contains("redacted"));
    }
    assert_eq!(redact_line("npm ERR! network unavailable"), "npm ERR! network unavailable");
}

/// Opt-in end-to-end run against a real staged bundle and a real server package:
/// unpack the official Node, then `npm install` the given .tgz into the private prefix.
#[test]
#[ignore = "unpacks a staged bundle and runs a real npm install"]
fn isolated_real_bundle_and_install() {
    let (home, bundle, package) = integration_inputs();
    isolate_integration_environment(&home);
    let owner = InstallGuard::begin().unwrap();
    let log = |line: &str| eprintln!("{}", redact_line(line));
    let selected = ensure_server(
        &home,
        &bundle,
        OsStr::new(PATH),
        || Ok(package.into_os_string()),
        "2026.8.20",
        owner.token(),
        &log,
    )
    .unwrap();
    assert!(selected.server.as_ref().unwrap().managed);
    eprintln!("Isolated selection: {}", home.join("runtime/selection.json").display());
    let again = ensure_server(&home, &bundle, OsStr::new("/nonexistent"), || panic!("reinstall"), "2026.8.20", owner.token(), &log)
        .unwrap();
    assert_eq!(selected, again);
}

// Only the explicitly filtered, ignored integration test calls this.
fn isolate_integration_environment(home: &Path) {
    let login = home.join("test-login-home");
    std::fs::create_dir_all(&login).unwrap();
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().to_ascii_lowercase().starts_with("npm_config_") {
            std::env::remove_var(key);
        }
    }
    std::env::remove_var("CORTEX_NPM_PREFIX");
    std::env::set_var("HOME", login);
    std::env::set_var("CORTEX_HOME", home);
}

fn integration_inputs() -> (PathBuf, PathBuf, PathBuf) {
    let var = |key: &str| PathBuf::from(std::env::var_os(key).unwrap_or_else(|| panic!("set {key}")));
    let (home, bundle, package) = (
        var("CORTEX_RUNTIME_TEST_HOME"),
        var("CORTEX_RUNTIME_TEST_BUNDLE"),
        var("CORTEX_RUNTIME_TEST_PACKAGE"),
    );
    assert!(home.is_absolute() && !home.exists(), "test home must be a new absolute path");
    assert!(bundle.join("manifest.json").is_file());
    assert!(package.is_absolute() && package.is_file());
    (home, bundle, package)
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
    let path = selection.path(OsStr::new("/other/bin:/usr/bin")).unwrap();
    let parts: Vec<_> = std::env::split_paths(&path).collect();
    assert_eq!(parts[0], Path::new("/chosen/bin"));
    assert_eq!(parts[1], Path::new("/private/prefix/bin"));
}

#[test]
fn cancellation_is_owned_and_does_not_poison_next_install() {
    let _serial = CANCEL_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let owner = InstallGuard::begin().unwrap();
    assert!(InstallGuard::begin().is_err());
    cancel_install();
    assert_eq!(owner.token().check().unwrap_err(), "SETUP_CANCELLED");
    drop(owner);
    cancel_install();
    assert!(InstallGuard::begin().unwrap().token().check().is_ok());
}
